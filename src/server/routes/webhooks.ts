import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { EventName } from "@paddle/paddle-node-sdk";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userBilling, PLAN_USAGE_USD, type BillingPlan } from "../../db/schema.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { paddleClient, claim, applyPaddleSubscription, applyPaddleTopUpTransaction } from "../../billing/paddle.js";

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

      if (!userId || !plan || !(plan in PLAN_USAGE_USD)) {
        logger.warn({ metadata }, "[stripe] checkout.session.completed: missing/invalid metadata");
        break;
      }

      const customerId = session["customer"] as string | null;
      const subscriptionId = session["subscription"] as string | null;
      const now = new Date();
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      await db
        .update(userBilling)
        .set({
          plan,
          monthlyLimitUsd: PLAN_USAGE_USD[plan],
          usageUsd: 0,
          rolloverUsd: 0,
          ...(customerId ? { stripeCustomerId: customerId } : {}),
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          updatedAt: now,
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
            monthlyLimitUsd: PLAN_USAGE_USD.free,
            rolloverUsd: 0,
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

// POST /api/webhooks/paddle
// Must receive the raw body — same requirement as /stripe above (register
// before any body-parsing middleware). Runs alongside Stripe — additive.
webhooksRouter.post("/paddle", async (c) => {
  const secret = config.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("[paddle] PADDLE_WEBHOOK_SECRET not set — webhook rejected");
    return c.json({ error: "Webhook not configured on this server" }, 503);
  }

  const signature = c.req.header("paddle-signature") ?? "";
  const rawBody = await c.req.text();

  let event;
  try {
    event = await paddleClient().webhooks.unmarshal(rawBody, secret, signature);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[paddle] webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 400);
  }

  if (!event) {
    logger.warn("[paddle] unmarshal returned no event — malformed payload");
    return c.json({ error: "Unrecognized event" }, 400);
  }

  logger.info({ type: event.eventType, eventId: event.eventId }, "[paddle] webhook received");

  // General replay guard for this webhook delivery. Note: the money-critical
  // top-up path additionally claims its own key inside
  // applyPaddleTopUpTransaction (keyed on the transaction id, not this event
  // id) because that action is also reachable from the sync-after-checkout
  // endpoint, which has no webhook event id at all — see billing.ts's
  // POST /paddle/sync and paddle.ts's doc comment on that function.
  if (!(await claim(`evt:${event.eventId}`))) {
    logger.info({ eventId: event.eventId }, "[paddle] webhook already processed — skipping (idempotent replay)");
    return c.json({ received: true });
  }

  switch (event.eventType) {
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
      await applyPaddleSubscription(event.data);
      break;

    case EventName.TransactionCompleted:
      await applyPaddleTopUpTransaction(event.data);
      break;

    default:
      logger.info({ type: event.eventType }, "[paddle] unhandled event type — ignored");
  }

  return c.json({ received: true });
});

export { webhooksRouter };
