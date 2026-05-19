/**
 * Billing routes — plan management, usage tracking, invoices, Stripe upgrade.
 * When STRIPE_SECRET_KEY is absent the endpoints work in "dev mode" returning
 * sensible stubs so the rest of the app functions without a Stripe account.
 *
 * Mounted at /api/users/me/billing
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, sum, count } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  userBilling,
  agentTasks,
  buildSessions,
  PLAN_CREDITS,
  type BillingPlan,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { logger } from "../logger.js";

// ── Stripe helpers (direct REST — no npm package required) ────────────────────

const STRIPE_BASE = "https://api.stripe.com/v1";

function stripeKey(): string {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
  return key;
}

async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${stripeKey()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AppError(res.status, `Stripe error: ${body}`, "STRIPE_ERROR");
  }
  return res.json() as Promise<T>;
}

async function stripePost<T>(path: string, data: Record<string, string | number | boolean>): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) body.append(k, String(v));
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(res.status, `Stripe error: ${text}`, "STRIPE_ERROR");
  }
  return res.json() as Promise<T>;
}

// ── Plan prices (Stripe price IDs from env, with dev fallbacks) ───────────────

function planPriceId(plan: "pro" | "enterprise"): string {
  const key = plan === "pro" ? "STRIPE_PRICE_PRO" : "STRIPE_PRICE_ENTERPRISE";
  return process.env[key] ?? `price_${plan}_placeholder`;
}

// ── Billing record upsert ─────────────────────────────────────────────────────

async function getOrCreateBilling(userId: string) {
  const rows = await db
    .select()
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  if (rows[0]) return rows[0];

  const now  = new Date();
  const end  = new Date(now);
  end.setMonth(end.getMonth() + 1);

  const [created] = await db
    .insert(userBilling)
    .values({
      userId,
      plan:                "free",
      creditsLimit:        PLAN_CREDITS.free,
      creditsUsed:         0,
      currentPeriodStart:  now,
      currentPeriodEnd:    end,
      cancelAtPeriodEnd:   false,
      createdAt:           now,
      updatedAt:           now,
    })
    .returning();

  if (!created) throw new AppError(500, "Failed to initialise billing", "INTERNAL_ERROR");
  return created;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(400, r.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  return r.data;
}

const upgradeSchema = z.object({
  plan:        z.enum(["pro", "enterprise"]),
  successUrl:  z.string().url("successUrl must be a valid URL"),
  cancelUrl:   z.string().url("cancelUrl must be a valid URL"),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const billingRouter = new Hono();
billingRouter.use("/*", requireAuth);

// GET /api/users/me/billing
billingRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const billing  = await getOrCreateBilling(authUser.id);

  return c.json({
    billing: {
      plan:               billing.plan,
      creditsLimit:       billing.creditsLimit,
      creditsUsed:        billing.creditsUsed,
      creditsRemaining:   Math.max(0, billing.creditsLimit - billing.creditsUsed),
      currentPeriodStart: billing.currentPeriodStart?.toISOString(),
      currentPeriodEnd:   billing.currentPeriodEnd?.toISOString(),
      cancelAtPeriodEnd:  billing.cancelAtPeriodEnd,
      stripeCustomerId:   billing.stripeCustomerId,
    },
  });
});

// GET /api/users/me/billing/usage
billingRouter.get("/usage", async (c) => {
  const authUser = c.get("authUser");
  const billing  = await getOrCreateBilling(authUser.id);

  // Credits consumed = sum of costUsd * 100 across agent tasks (1 credit = $0.01)
  const [tokenSums] = await db
    .select({
      totalInputTokens:  sum(agentTasks.inputTokens),
      totalOutputTokens: sum(agentTasks.outputTokens),
      totalCostUsd:      sum(agentTasks.costUsd),
      taskCount:         count(agentTasks.id),
    })
    .from(agentTasks)
    .where(eq(agentTasks.userId, authUser.id));

  const [sessionSums] = await db
    .select({
      totalCreditsUsed: sum(buildSessions.creditsUsed),
      sessionCount:     count(buildSessions.id),
    })
    .from(buildSessions)
    .where(eq(buildSessions.userId, authUser.id));

  return c.json({
    usage: {
      creditsLimit:        billing.creditsLimit,
      creditsUsed:         billing.creditsUsed,
      creditsRemaining:    Math.max(0, billing.creditsLimit - billing.creditsUsed),
      periodStart:         billing.currentPeriodStart?.toISOString(),
      periodEnd:           billing.currentPeriodEnd?.toISOString(),
      totalSessions:       Number(sessionSums?.sessionCount ?? 0),
      totalTasks:          Number(tokenSums?.taskCount ?? 0),
      totalInputTokens:    Number(tokenSums?.totalInputTokens ?? 0),
      totalOutputTokens:   Number(tokenSums?.totalOutputTokens ?? 0),
      totalCostUsd:        Number(tokenSums?.totalCostUsd ?? 0),
      totalSessionCredits: Number(sessionSums?.totalCreditsUsed ?? 0),
    },
  });
});

// GET /api/users/me/billing/invoices
billingRouter.get("/invoices", async (c) => {
  const authUser = c.get("authUser");
  const billing  = await getOrCreateBilling(authUser.id);

  if (!billing.stripeCustomerId || !process.env["STRIPE_SECRET_KEY"]) {
    return c.json({ invoices: [], message: "No billing history — upgrade to a paid plan" });
  }

  interface StripeInvoice {
    id: string;
    amount_paid: number;
    currency: string;
    status: string;
    created: number;
    hosted_invoice_url: string | null;
    invoice_pdf: string | null;
    number: string | null;
  }
  interface StripeInvoiceList { data: StripeInvoice[] }

  try {
    const list = await stripeGet<StripeInvoiceList>(
      `/invoices?customer=${billing.stripeCustomerId}&limit=24`,
    );
    const invoices = list.data.map((inv) => ({
      id:         inv.id,
      number:     inv.number,
      amountPaid: inv.amount_paid,
      currency:   inv.currency,
      status:     inv.status,
      createdAt:  new Date(inv.created * 1000).toISOString(),
      invoiceUrl: inv.hosted_invoice_url,
      pdfUrl:     inv.invoice_pdf,
    }));
    return c.json({ invoices });
  } catch (err) {
    logger.warn({ userId: authUser.id, err }, "Failed to fetch invoices from Stripe");
    return c.json({ invoices: [], message: "Could not retrieve invoices" });
  }
});

// POST /api/users/me/billing/upgrade
billingRouter.post("/upgrade", async (c) => {
  const authUser = c.get("authUser");
  const billing  = await getOrCreateBilling(authUser.id);

  const body = parseBody(
    upgradeSchema,
    await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); }),
  );

  const { plan, successUrl, cancelUrl } = body;

  if ((billing.plan as BillingPlan) === plan) {
    throw new AppError(409, `Already on the ${plan} plan`, "ALREADY_ON_PLAN");
  }

  // Ensure Stripe is configured
  stripeKey(); // throws if not set

  // Get or create Stripe customer
  let customerId = billing.stripeCustomerId;

  if (!customerId) {
    interface StripeCustomer { id: string }
    const customer = await stripePost<StripeCustomer>("/customers", {
      email:    authUser.email,
      name:     authUser.name,
      metadata: JSON.stringify({ userId: authUser.id }),
    });
    customerId = customer.id;

    await db
      .update(userBilling)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(userBilling.userId, authUser.id));
  }

  // Create a Stripe Checkout session
  interface StripeSession { id: string; url: string | null }
  const session = await stripePost<StripeSession>("/checkout/sessions", {
    customer:    customerId,
    mode:        "subscription",
    line_items:  JSON.stringify([{ price: planPriceId(plan), quantity: 1 }]),
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata:    JSON.stringify({ userId: authUser.id, plan }),
  });

  logger.info({ userId: authUser.id, plan, sessionId: session.id }, "Stripe checkout session created");

  return c.json({
    checkoutUrl: session.url,
    sessionId:   session.id,
    plan,
  });
});
