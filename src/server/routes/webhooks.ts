import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userBilling, PLAN_CREDITS, type BillingPlan } from "../../db/schema.js";
import { logger } from "../logger.js";

const webhooksRouter = new Hono();

// Verify Stripe webhook signature using HMAC-SHA256.
// Avoids the `stripe` npm package — consistent with billing.ts which uses raw fetch.
function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  // Header format: "t=<timestamp>,v1=<sig1>,v1=<sig2>"
  const parts: Record<string, string> = {};
  for (const chunk of signatureHeader.split(",")) {
    const idx = chunk.indexOf("=");
    if (idx !== -1) parts[chunk.slice(0, idx)] = chunk.slice(idx + 1);
  }

  const timestamp = parts["t"];
  const expected = parts["v1"];
  if (!timestamp || !expected) return false;

  // Replay attack protection: reject events older than 5 minutes.
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 300) return false;

  const computed = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// POST /api/webhooks/stripe
// Must receive the raw body — do NOT parse as JSON before this handler.
// Register this route before any body-parsing middleware on the parent app.
webhooksRouter.post("/stripe", async (c) => {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) {
    logger.warn("[stripe] STRIPE_WEBHOOK_SECRET not set — webhook rejected");
    return c.json({ error: "Webhook not configured on this server" }, 503);
  }

  const signatureHeader = c.req.header("stripe-signature") ?? "";
  const rawBody = await c.req.text();

  if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
    logger.warn("[stripe] invalid webhook signature");
    return c.json({ error: "Invalid signature" }, 400);
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  logger.info({ type: event.type }, "[stripe] webhook received");

  switch (event.type) {
    // ── Payment confirmed — upgrade the plan ─────────────────────────────────
    case "checkout.session.completed": {
      const session = event.data.object;
      const metadata = session["metadata"] as Record<string, string> | null;
      const userId = metadata?.["userId"];
      const plan = metadata?.["plan"] as BillingPlan | undefined;

      if (!userId || !plan || !(plan in PLAN_CREDITS)) {
        logger.warn({ metadata }, "[stripe] checkout.session.completed: missing/invalid metadata");
        break;
      }

      const customerId = session["customer"] as string | null;
      const subscriptionId = session["subscription"] as string | null;

      await db
        .update(userBilling)
        .set({
          plan,
          creditsLimit: PLAN_CREDITS[plan],
          creditsUsed: 0,
          ...(customerId ? { stripeCustomerId: customerId } : {}),
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          currentPeriodStart: new Date(),
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(userBilling.userId, userId));

      logger.info({ userId, plan }, "[stripe] plan upgraded successfully");
      break;
    }

    // ── Subscription changed (renewal, cancellation schedule, downgrade) ─────
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const customerId = sub["customer"] as string;
      const status = sub["status"] as string;
      const cancelAtPeriodEnd = sub["cancel_at_period_end"] as boolean;
      const currentPeriodEnd = sub["current_period_end"] as number | undefined;

      if (status === "canceled") {
        await db
          .update(userBilling)
          .set({
            plan: "free",
            creditsLimit: PLAN_CREDITS.free,
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .where(eq(userBilling.stripeCustomerId, customerId));

        logger.info({ customerId }, "[stripe] subscription cancelled → downgraded to free");
      } else {
        await db
          .update(userBilling)
          .set({
            cancelAtPeriodEnd,
            ...(currentPeriodEnd
              ? { currentPeriodEnd: new Date(currentPeriodEnd * 1000) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(userBilling.stripeCustomerId, customerId));

        logger.info({ customerId, cancelAtPeriodEnd, status }, "[stripe] subscription updated");
      }
      break;
    }

    // ── Payment failed — log for ops visibility ───────────────────────────────
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      logger.warn(
        { customerId: invoice["customer"], attemptCount: invoice["attempt_count"] },
        "[stripe] invoice.payment_failed",
      );
      break;
    }

    default:
      logger.info({ type: event.type }, "[stripe] unhandled event type — ignored");
  }

  return c.json({ received: true });
});

export { webhooksRouter };
