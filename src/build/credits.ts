import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userBilling } from "../db/schema.js";
import { AppError } from "../server/middleware/error-handler.js";

/**
 * Ensure every authenticated user has at least 500 starter credits.
 * - Inserts a billing row if one doesn't exist yet.
 * - If a row exists with creditsLimit below 500, bumps it up (covers users
 *   created before the default was raised from 100 → 500).
 * - Never reduces a limit that is already above 500 (paid plans).
 * Safe to call on every request — uses a single upsert.
 */
export async function ensureStartingCredits(userId: string): Promise<void> {
  await db
    .insert(userBilling)
    .values({
      userId,
      plan: "free",
      creditsLimit: 500,
      creditsUsed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userBilling.userId,
      set: {
        creditsLimit: sql`GREATEST(${userBilling.creditsLimit}, 500)`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Atomically deduct `amount` credits from the user's balance.
 * Uses a single UPDATE with a WHERE constraint to prevent races.
 * Throws 402 INSUFFICIENT_CREDITS if the deduction cannot be applied.
 */
export async function deductCredits(userId: string, amount: number): Promise<void> {
  // Auto-provision a free billing record for users created before billing was set up.
  // ON CONFLICT DO NOTHING makes this a safe no-op when the row already exists.
  await db
    .insert(userBilling)
    .values({
      userId,
      plan: "free",
      creditsLimit: 500,
      creditsUsed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  const rows = await db
    .update(userBilling)
    .set({
      creditsUsed: sql`credits_used + ${amount}`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${userBilling.userId} = ${userId} AND credits_used + ${amount} <= credits_limit`,
    )
    .returning({ creditsUsed: userBilling.creditsUsed });

  if (rows.length === 0) {
    // Either no billing row, or insufficient credits
    const billing = await db
      .select({ creditsUsed: userBilling.creditsUsed, creditsLimit: userBilling.creditsLimit })
      .from(userBilling)
      .where(eq(userBilling.userId, userId))
      .limit(1);

    if (billing.length === 0) {
      throw new AppError(402, "No billing record found. Please set up your account.", "BILLING_NOT_FOUND");
    }
    const { creditsUsed, creditsLimit } = billing[0]!;
    const remaining = creditsLimit - creditsUsed;
    throw new AppError(
      402,
      `Insufficient credits. ${remaining} remaining, ${amount} required.`,
      "INSUFFICIENT_CREDITS",
    );
  }
}

/**
 * Refund `amount` credits back to the user.
 * Best-effort: never throws so callers can use it in error paths.
 */
export async function refundCredits(userId: string, amount: number): Promise<void> {
  try {
    await db
      .update(userBilling)
      .set({
        creditsUsed: sql`GREATEST(0, credits_used - ${amount})`,
        updatedAt: sql`now()`,
      })
      .where(eq(userBilling.userId, userId));
  } catch {
    // swallow — refund is best-effort
  }
}
