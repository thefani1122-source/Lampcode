// Paddle billing integration — runs alongside the existing Stripe code in
// billing.ts/webhooks.ts (additive, neither replaces the other). This module
// holds everything shared between the webhook handler and the
// sync-after-checkout reconciliation endpoint, so both paths apply Paddle
// state through the exact same logic instead of two hand-maintained copies.
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userBilling, paddleProcessedEvents, PLAN_USAGE_USD } from "../db/schema.js";
import { config } from "../server/config.js";
import { addTopUp } from "../build/credits.js";
import { logger } from "../server/logger.js";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// ── Paddle client (lazy singleton, mirrors stripeKey()'s lazy-init pattern) ──

let _client: Paddle | null = null;

export function paddleClient(): Paddle {
  if (!config.PADDLE_API_KEY) {
    throw new Error("PADDLE_API_KEY is not configured");
  }
  if (!_client) {
    _client = new Paddle(config.PADDLE_API_KEY, {
      environment: config.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox,
    });
  }
  return _client;
}

// ── Price-ID → plan/top-up map ────────────────────────────────────────────────
// Env-var driven, same convention as billing.ts's Stripe planPriceId() — a
// sandbox→live catalog swap is an env var change, not a migration.

type PriceMapping =
  | { kind: "subscription"; plan: "pro" | "max" | "power" }
  | { kind: "topup"; amountUsd: number };

function buildPriceMap(): Map<string, PriceMapping> {
  const entries: Array<[string | undefined, PriceMapping]> = [
    [config.PADDLE_PRICE_PRO_MONTHLY, { kind: "subscription", plan: "pro" }],
    [config.PADDLE_PRICE_PRO_YEARLY, { kind: "subscription", plan: "pro" }],
    [config.PADDLE_PRICE_MAX_MONTHLY, { kind: "subscription", plan: "max" }],
    [config.PADDLE_PRICE_MAX_YEARLY, { kind: "subscription", plan: "max" }],
    [config.PADDLE_PRICE_POWER_MONTHLY, { kind: "subscription", plan: "power" }],
    [config.PADDLE_PRICE_POWER_YEARLY, { kind: "subscription", plan: "power" }],
    [config.PADDLE_PRICE_TOPUP_5, { kind: "topup", amountUsd: 5 }],
    [config.PADDLE_PRICE_TOPUP_15, { kind: "topup", amountUsd: 15 }],
    [config.PADDLE_PRICE_TOPUP_30, { kind: "topup", amountUsd: 30 }],
    [config.PADDLE_PRICE_TOPUP_75, { kind: "topup", amountUsd: 75 }],
  ];
  const map = new Map<string, PriceMapping>();
  for (const [priceId, mapping] of entries) {
    if (priceId) map.set(priceId, mapping);
  }
  return map;
}

let _priceMap: Map<string, PriceMapping> | null = null;

function classifyPrice(priceId: string): PriceMapping | undefined {
  if (!_priceMap) _priceMap = buildPriceMap();
  return _priceMap.get(priceId);
}

/** Exposed to billing.ts's GET /paddle/config so the frontend gets the same
 *  price IDs the backend actually recognizes — one source of truth. */
export function paddlePriceConfig() {
  return {
    pro: { monthly: config.PADDLE_PRICE_PRO_MONTHLY, yearly: config.PADDLE_PRICE_PRO_YEARLY },
    max: { monthly: config.PADDLE_PRICE_MAX_MONTHLY, yearly: config.PADDLE_PRICE_MAX_YEARLY },
    power: { monthly: config.PADDLE_PRICE_POWER_MONTHLY, yearly: config.PADDLE_PRICE_POWER_YEARLY },
    topups: {
      5: config.PADDLE_PRICE_TOPUP_5,
      15: config.PADDLE_PRICE_TOPUP_15,
      30: config.PADDLE_PRICE_TOPUP_30,
      75: config.PADDLE_PRICE_TOPUP_75,
    },
  };
}

// ── Idempotency ────────────────────────────────────────────────────────────────

/**
 * Atomically claims `key` — returns true the first time (safe to process),
 * false on every subsequent call with the same key (already processed,
 * caller should no-op). Backed by the table's primary key + onConflictDoNothing,
 * so concurrent/duplicate deliveries can't both "win" — no read-then-write race.
 */
export async function claim(key: string): Promise<boolean> {
  const inserted = await db
    .insert(paddleProcessedEvents)
    .values({ claimKey: key })
    .onConflictDoNothing()
    .returning({ claimKey: paddleProcessedEvents.claimKey });
  return inserted.length > 0;
}

// ── Shared entity shapes ──────────────────────────────────────────────────────
// Structurally satisfied by BOTH the webhook SDK's *Notification classes and
// the REST .get() Subscription/Transaction entities (verified against the
// installed SDK's real .d.ts files — same camelCase field names in both),
// so the same functions below serve the webhook handler and the sync endpoint.

interface SubscriptionLike {
  id: string;
  status: string;
  customerId: string;
  items: Array<{ price: { id: string } | null }>;
  customData: Record<string, unknown> | null;
  scheduledChange: { action: string } | null;
}

interface TransactionLike {
  id: string;
  customData: Record<string, unknown> | null;
  items: Array<{ price: { id: string } | null }>;
}

function extractUserId(customData: Record<string, unknown> | null): string | undefined {
  const userId = customData?.["userId"];
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

// ── Subscription state application (subscription.created/updated/canceled) ──

async function downgradeToFree(customerId: string): Promise<void> {
  await db
    .update(userBilling)
    .set({
      plan: "free",
      monthlyLimitUsd: PLAN_USAGE_USD.free,
      rolloverUsd: 0,
      paddleSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(userBilling.paddleCustomerId, customerId));

  logger.info({ customerId }, "[paddle] subscription canceled → downgraded to free");
}

/**
 * Applies a subscription's current state. Handles subscription.created,
 * subscription.updated (including a scheduled-cancel flag with no plan
 * change), and subscription.canceled (status === "canceled" means the
 * subscription has actually ended — verified against Paddle's docs that this
 * fires only at true termination, not at cancel-request time; the "will
 * cancel later" case arrives as subscription.updated with a scheduledChange
 * instead, which only sets cancelAtPeriodEnd here — mirrors the existing
 * Stripe webhook's exact split, no new behavior invented).
 *
 * Deliberately does NOT reset usageUsd/currentPeriodStart/currentPeriodEnd on
 * every update — only on a genuine plan change (detected by comparing against
 * the currently stored plan). ensureCurrentPeriod (credits.ts) owns the
 * monthly usage clock; a renewal/payment-method/scheduled-cancel ping must
 * not reset a user's usage period just because Paddle sent a notification.
 */
export async function applyPaddleSubscription(sub: SubscriptionLike): Promise<void> {
  if (sub.status === "canceled") {
    await downgradeToFree(sub.customerId);
    return;
  }

  const cancelAtPeriodEnd = sub.scheduledChange?.action === "cancel";
  const priceId = sub.items[0]?.price?.id;
  const mapping = priceId ? classifyPrice(priceId) : undefined;
  const recognizedPlan = mapping?.kind === "subscription" ? mapping.plan : undefined;
  const isActivatable = (sub.status === "active" || sub.status === "trialing") && recognizedPlan !== undefined;

  if (!isActivatable) {
    // past_due/paused, or an update we don't recognize a plan price on —
    // only keep the cancel-at-period-end flag in sync, touch nothing else.
    await db
      .update(userBilling)
      .set({ cancelAtPeriodEnd, updatedAt: new Date() })
      .where(eq(userBilling.paddleCustomerId, sub.customerId));
    return;
  }

  const existing = (
    await db
      .select({ plan: userBilling.plan })
      .from(userBilling)
      .where(eq(userBilling.paddleCustomerId, sub.customerId))
      .limit(1)
  )[0];

  const isNewActivation = !existing || existing.plan !== recognizedPlan;

  if (!isNewActivation) {
    // Same plan as already stored — a renewal or other ping, not a change.
    // Don't touch usage/period; do keep the subscription id + cancel flag fresh.
    await db
      .update(userBilling)
      .set({ paddleSubscriptionId: sub.id, cancelAtPeriodEnd, updatedAt: new Date() })
      .where(eq(userBilling.paddleCustomerId, sub.customerId));
    return;
  }

  const userId = extractUserId(sub.customData);
  if (!userId) {
    logger.warn(
      { subscriptionId: sub.id },
      "[paddle] plan change detected but no userId in custom_data — cannot activate",
    );
    return;
  }

  const now = new Date();
  await db
    .update(userBilling)
    .set({
      plan: recognizedPlan,
      monthlyLimitUsd: PLAN_USAGE_USD[recognizedPlan],
      usageUsd: 0,
      rolloverUsd: 0,
      paddleCustomerId: sub.customerId,
      paddleSubscriptionId: sub.id,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + ONE_MONTH_MS),
      cancelAtPeriodEnd,
      updatedAt: now,
    })
    .where(eq(userBilling.userId, userId));

  logger.info({ userId, plan: recognizedPlan, subscriptionId: sub.id }, "[paddle] plan activated");
}

// ── Transaction handling (transaction.completed → top-up only) ──────────────

/**
 * transaction.completed fires for BOTH subscription payments and one-time
 * top-ups — subscription activation is handled entirely by the subscription
 * events above, so this only acts when an item's price matches one of the
 * 4 top-up prices; everything else is ignored here.
 *
 * Idempotency is keyed on the transaction id specifically (not the caller's
 * webhook event id) because this is reachable from two independent paths —
 * the webhook AND the sync-after-checkout endpoint — and addTopUp() is an
 * additive increment. Whichever path claims "txn:<id>" first wins; the other
 * is a safe no-op.
 */
export async function applyPaddleTopUpTransaction(txn: TransactionLike): Promise<void> {
  const userId = extractUserId(txn.customData);
  if (!userId) {
    logger.warn({ transactionId: txn.id }, "[paddle] transaction has no userId in custom_data — cannot apply");
    return;
  }

  const topUpItems = txn.items
    .map((item) => (item.price ? classifyPrice(item.price.id) : undefined))
    .filter((m): m is Extract<PriceMapping, { kind: "topup" }> => m?.kind === "topup");

  if (topUpItems.length === 0) return; // not a top-up transaction — ignore

  if (!(await claim(`txn:${txn.id}`))) {
    logger.info({ transactionId: txn.id }, "[paddle] transaction already credited — skipping (idempotent replay)");
    return;
  }

  for (const item of topUpItems) {
    await addTopUp(userId, item.amountUsd);
    logger.info({ userId, amountUsd: item.amountUsd, transactionId: txn.id }, "[paddle] top-up applied");
  }
}
