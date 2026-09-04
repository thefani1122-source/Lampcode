/**
 * Temporary admin maintenance routes — mounted at /api/admin.
 *
 * ⚠️ TESTING PHASE ONLY. These endpoints allow direct manipulation of a
 * user's USD billing balance and must be removed (or locked down further)
 * before production launch.
 *
 * Authorization for each endpoint accepts EITHER:
 *   - a valid `x-admin-secret` header matching process.env.ADMIN_SECRET, OR
 *   - a Bearer token belonging to an email in ADMIN_EMAILS.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userBilling } from "../../db/schema.js";
import { isAdmin } from "../../auth/admin.js";
import { getSupabaseAdmin } from "../../auth/supabase-server.js";

export const adminRouter = new Hono();

/** Returns true if the request is authorized as an admin. */
async function isAuthorized(c: Context): Promise<boolean> {
  // 1. Shared-secret header (only honoured when the env var is actually set).
  const configuredSecret = process.env["ADMIN_SECRET"];
  const providedSecret = c.req.header("x-admin-secret");
  if (configuredSecret && providedSecret && providedSecret === configuredSecret) {
    return true;
  }

  // 2. Authenticated admin email.
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const supabase = getSupabaseAdmin();
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user?.email && isAdmin(user.email)) return true;
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
