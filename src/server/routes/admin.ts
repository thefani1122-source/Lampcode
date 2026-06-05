/**
 * Temporary admin maintenance routes — mounted at /api/admin.
 *
 * ⚠️ TESTING PHASE ONLY. These endpoints allow direct credit manipulation and
 * must be removed (or locked down further) before production launch.
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
  amount: z.number().int().min(0).max(1_000_000).default(500),
});

// POST /api/admin/add-credits — reset a user's credit balance to `amount`.
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

  const { userId, amount } = parsed.data;
  const now = new Date();

  // Upsert: set the limit to `amount` and reset usage to 0 so the user has the
  // full `amount` available.
  await db
    .insert(userBilling)
    .values({
      userId,
      plan: "free",
      creditsLimit: amount,
      creditsUsed: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userBilling.userId,
      set: {
        creditsLimit: amount,
        creditsUsed: 0,
        updatedAt: now,
      },
    });

  const [row] = await db
    .select({ creditsLimit: userBilling.creditsLimit, creditsUsed: userBilling.creditsUsed })
    .from(userBilling)
    .where(eq(userBilling.userId, userId))
    .limit(1);

  return c.json({
    success: true,
    userId,
    creditsLimit: row?.creditsLimit ?? amount,
    creditsUsed: row?.creditsUsed ?? 0,
    creditsRemaining: (row?.creditsLimit ?? amount) - (row?.creditsUsed ?? 0),
  });
});
