import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userBilling, PLAN_USAGE_USD, PLAN_ROLLOVER_CAP_USD, type BillingPlan, type UsageCategory } from "../db/schema.js";
import { config } from "../server/config.js";
import { AppError } from "../server/middleware/error-handler.js";
import { logger } from "../server/logger.js";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ensure a userBilling row exists for `userId`. Free tier, matching
 * PLAN_USAGE_USD.free. Safe to call on every request — single upsert,
 * never reduces an existing row (covers users created before billing existed).
 */
export async function ensureBillingRow(userId: string): Promise<void> {
  const now = new Date();
  const end = new Date(now.getTime() + ONE_MONTH_MS);
  await db
    .insert(userBilling)
    .values({
      userId,
      plan: "free",
      monthlyLimitUsd: PLAN_USAGE_USD.free,
      usageUsd: 0,
      rolloverUsd: 0,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Lazy monthly reset. No cron/scheduled job resets userBilling today (the
 * only historical reset path was the Stripe plan-change webhook) — so this
 * runs on-demand, before any balance read or deduction, and catches the
 * period up if it's stale.
 *
 * On rollover: unused balance (monthlyLimitUsd + rolloverUsd - usageUsd) is
 * capped at PLAN_ROLLOVER_CAP_USD[plan] and carried as the new rolloverUsd;
 * usageUsd resets to 0. For plans with cap 0 (everything but power today)
 * this always carries 0 — use-it-or-lose-it.
 *
 * A dormant account that's skipped many periods gets ONE reset step, not one
 * per skipped period — the rollover cap makes iterating pointless (a capped
 * carry-over is already at its ceiling after the first step regardless of
 * how many periods were actually skipped).
 */
export async function ensureCurrentPeriod(userId: string): Promise<void> {
  await ensureBillingRow(userId);

  const rows = await db
    .select({
      plan: userBilling.plan,
      monthlyLimitUsd: userBilling.monthlyLimitUsd,
      usageUsd: userBilling.usageUsd,
      rolloverUsd: userBilling.rolloverUsd,
      currentPeriodEnd: userBilling.currentPeriodEnd,
    })
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  const billing = rows[0];
  if (!billing || !billing.currentPeriodEnd) return;

  const now = new Date();
  if (now <= billing.currentPeriodEnd) return; // still within the current period

  const plan = billing.plan as BillingPlan;
  const unused = Math.max(0, billing.monthlyLimitUsd + billing.rolloverUsd - billing.usageUsd);
  const newRollover = Math.min(unused, PLAN_ROLLOVER_CAP_USD[plan] ?? 0);
  const newStart = now;
  const newEnd = new Date(now.getTime() + ONE_MONTH_MS);

  await db
    .update(userBilling)
    .set({
      usageUsd: 0,
      rolloverUsd: newRollover,
      monthlyLimitUsd: PLAN_USAGE_USD[plan] ?? PLAN_USAGE_USD.free,
      currentPeriodStart: newStart,
      currentPeriodEnd: newEnd,
      updatedAt: now,
    })
    .where(eq(userBilling.userId, userId));

  logger.info({ userId, plan, newRollover }, "Billing period rolled over");
}

/**
 * Pre-flight check before starting a build — does the user have any budget
 * left at all? Does NOT deduct anything (there's no flat per-build charge
 * anymore; real usage is deducted per-dispatch as it's actually incurred,
 * see deductUsage). Throws 402 if remaining balance is not positive.
 */
export async function assertHasBudget(userId: string): Promise<void> {
  await ensureCurrentPeriod(userId);

  const rows = await db
    .select({
      monthlyLimitUsd: userBilling.monthlyLimitUsd,
      usageUsd: userBilling.usageUsd,
      rolloverUsd: userBilling.rolloverUsd,
    })
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  const billing = rows[0];
  if (!billing) {
    throw new AppError(402, "No billing record found. Please set up your account.", "BILLING_NOT_FOUND");
  }

  const remaining = billing.monthlyLimitUsd + billing.rolloverUsd - billing.usageUsd;
  if (remaining <= 0) {
    throw new AppError(
      402,
      `Insufficient usage balance. $${remaining.toFixed(2)} remaining this period.`,
      "INSUFFICIENT_BALANCE",
    );
  }
}

/**
 * Record real usage from a completed dispatch: actualCostUsd × margin,
 * deducted from the user's balance. Called once per dispatch, after it
 * completes — see dispatcher.ts. Best-effort (never throws): the model call
 * already happened and tokens were already spent, so there's nothing
 * meaningful to reject after the fact. This can push usageUsd slightly past
 * monthlyLimitUsd on a build's final dispatch — expected, bounded by
 * MAX_BUILD_COST_USD (a separate, independent per-build ceiling) and by
 * assertHasBudget refusing to START a build with zero balance left.
 */
export async function deductUsage(
  userId: string,
  actualCostUsd: number,
  category: UsageCategory,
): Promise<void> {
  try {
    await ensureCurrentPeriod(userId);
    const usageUsd = actualCostUsd * config.USAGE_MARGIN_MULTIPLIER;
    await db
      .update(userBilling)
      .set({
        usageUsd: sql`${userBilling.usageUsd} + ${usageUsd}`,
        updatedAt: sql`now()`,
      })
      .where(eq(userBilling.userId, userId));
    logger.debug({ userId, category, actualCostUsd, usageUsd }, "Usage deducted");
  } catch (err) {
    logger.warn({ userId, category, err }, "Failed to record usage deduction");
  }
}

/**
 * Remaining balance for display (billing.ts, users.ts, sidebar). Applies the
 * lazy period reset first so a stale period never shows a wrong number.
 */
export async function getRemainingBudget(
  userId: string,
): Promise<{ monthlyLimitUsd: number; usageUsd: number; rolloverUsd: number; remainingUsd: number }> {
  await ensureCurrentPeriod(userId);

  const rows = await db
    .select({
      monthlyLimitUsd: userBilling.monthlyLimitUsd,
      usageUsd: userBilling.usageUsd,
      rolloverUsd: userBilling.rolloverUsd,
    })
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  const billing = rows[0] ?? { monthlyLimitUsd: PLAN_USAGE_USD.free, usageUsd: 0, rolloverUsd: 0 };
  return {
    ...billing,
    remainingUsd: Math.max(0, billing.monthlyLimitUsd + billing.rolloverUsd - billing.usageUsd),
  };
}

/**
 * Admin/top-up grant: add `amountUsd` directly to the user's balance for
 * this period (used by a top-up purchase, or an admin manual grant).
 * Implemented as a bump to monthlyLimitUsd for the current period — simplest
 * correct effect ("your available balance this period just went up by $X")
 * without a separate top-up ledger.
 */
export async function addTopUp(userId: string, amountUsd: number): Promise<void> {
  await ensureCurrentPeriod(userId);
  await db
    .update(userBilling)
    .set({
      monthlyLimitUsd: sql`${userBilling.monthlyLimitUsd} + ${amountUsd}`,
      updatedAt: sql`now()`,
    })
    .where(eq(userBilling.userId, userId));
}
