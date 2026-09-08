/**
 * Admin maintenance routes — mounted at /api/admin. Kept in production as a
 * support tool for manual billing adjustments (refunds, goodwill credits),
 * not removed — but the auth surface is deliberately fail-closed.
 *
 * ADMIN_SECRET is a hard prerequisite for the entire route: if it's unset or
 * empty, isAuthorized() returns false unconditionally and no other credential
 * (including a valid ADMIN_EMAILS admin session) can get in. Once that gate
 * passes, authorization accepts EITHER:
 *   - a valid `x-admin-secret` header matching process.env.ADMIN_SECRET, OR
 *   - a Bearer token for a user isAdminUser() confirms (email allow-list AND
 *     the DB role column — see src/auth/admin.ts).
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userBilling } from "../../db/schema.js";
import { isAdminUser } from "../../auth/admin.js";
import { getSupabaseAdmin } from "../../auth/supabase-server.js";

export const adminRouter = new Hono();

/** Returns true if the request is authorized as an admin. */
async function isAuthorized(c: Context): Promise<boolean> {
  // ADMIN_SECRET is a hard prerequisite for the whole route — if it isn't
  // configured, the admin surface is disabled outright, regardless of any
  // other credential presented below. Never fall open on a missing secret.
  const configuredSecret = process.env["ADMIN_SECRET"];
  if (!configuredSecret) return false;

  // 1. Shared-secret header.
  const providedSecret = c.req.header("x-admin-secret");
  if (providedSecret && providedSecret === configuredSecret) {
    return true;
  }

  // 2. Authenticated admin user — email allow-list AND DB role column, so an
  // email change via a social provider reconnect can't silently grant access.
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const supabase = getSupabaseAdmin();
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user?.id && (await isAdminUser(user.id, user.email))) return true;
    } catch {
      // fall through to unauthorized
    }
  }

  return false;
}

const addCreditsSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  amountUsd: z.number().min(0).max(100_000).default(3),
});

// POST /api/admin/add-credits — reset a user's usage balance to `amountUsd`
// (route path kept for compatibility; the unit is now real dollars, not
// integer credits — see db/schema.ts's userBilling rework).
adminRouter.post("/add-credits", async (c) => {
  if (!(await isAuthorized(c))) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  const parsed = addCreditsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      400,
    );
  }

  const { userId, amountUsd } = parsed.data;
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Upsert: set monthlyLimitUsd to amountUsd and reset usage/rollover so the
  // user has the full amountUsd available this period. topUpBalanceUsd is
  // deliberately absent from the onConflict `set` — an admin grant against
  // the plan allotment shouldn't wipe out real, already-paid top-up money;
  // it's only defaulted to 0 on the insert branch (brand-new row).
  await db
    .insert(userBilling)
    .values({
      userId,
      plan: "free",
      monthlyLimitUsd: amountUsd,
      usageUsd: 0,
      rolloverUsd: 0,
      topUpBalanceUsd: 0,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userBilling.userId,
      set: {
        monthlyLimitUsd: amountUsd,
        usageUsd: 0,
        rolloverUsd: 0,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        updatedAt: now,
      },
    });

  const [row] = await db
    .select({
      monthlyLimitUsd: userBilling.monthlyLimitUsd,
      usageUsd: userBilling.usageUsd,
      rolloverUsd: userBilling.rolloverUsd,
      topUpBalanceUsd: userBilling.topUpBalanceUsd,
    })
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  const monthlyLimitUsd = row?.monthlyLimitUsd ?? amountUsd;
  const usageUsd = row?.usageUsd ?? 0;
  const rolloverUsd = row?.rolloverUsd ?? 0;
  const topUpBalanceUsd = row?.topUpBalanceUsd ?? 0;
  return c.json({
    success: true,
    userId,
    monthlyLimitUsd,
    usageUsd,
    rolloverUsd,
    topUpBalanceUsd,
    remainingUsd: monthlyLimitUsd + rolloverUsd - usageUsd + topUpBalanceUsd,
  });
});
