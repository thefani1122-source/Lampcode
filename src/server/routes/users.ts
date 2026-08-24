import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { user as userTable, buildSessions } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { isAdmin } from "../../auth/admin.js";
import { getRemainingBudget } from "../../build/credits.js";

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  image: z.string().url().nullable().optional(),
});

const usersRouter = new Hono();

// All user routes require authentication
usersRouter.use("/*", requireAuth);

// GET /api/users/me — current user profile + live credit balance from DB
usersRouter.get("/me", async (c) => {
  const authUser = c.get("authUser");
  const [profile, budget] = await Promise.all([
    db
      .select()
      .from(userTable)
      .where(eq(userTable.id, authUser.id))
      .limit(1),
    getRemainingBudget(authUser.id),
  ]);

  if (profile[0] === undefined) {
    return c.json({ error: { message: "User not found", code: "NOT_FOUND" } }, 404);
  }

  const admin = isAdmin(authUser.email);

  return c.json({
    user: {
      ...profile[0],
      isAdmin: admin,
      // Always the live DB value (admins effectively have unlimited builds).
      usageUsd: budget.usageUsd,
      monthlyLimitUsd: budget.monthlyLimitUsd,
      rolloverUsd: budget.rolloverUsd,
      remainingUsd: admin ? Number.MAX_SAFE_INTEGER : budget.remainingUsd,
    },
  });
});

// PATCH /api/users/me — update profile fields
usersRouter.patch("/me", async (c) => {
  const authUser = c.get("authUser");
  const body = updateProfileSchema.parse(await c.req.json());

  type UserUpdate = {
    updatedAt: Date;
    name?: string;
    image?: string | null;
  };

  const updates: UserUpdate = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.image !== undefined) updates.image = body.image;

  const [updated] = await db
    .update(userTable)
    .set(updates)
    .where(eq(userTable.id, authUser.id))
    .returning();

  if (updated === undefined) {
    return c.json({ error: { message: "User not found", code: "NOT_FOUND" } }, 404);
  }

  return c.json({ user: updated });
});

// GET /api/users/me/usage — real credit balance + builds count
usersRouter.get("/me/usage", async (c) => {
  const authUser = c.get("authUser");

  const [budget, projectsBuiltRow] = await Promise.all([
    getRemainingBudget(authUser.id),
    db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(buildSessions)
      .where(eq(buildSessions.userId, authUser.id)),
  ]);

  const projectsBuilt = projectsBuiltRow[0]?.count ?? 0;

  return c.json({
    usage: {
      usageUsd: budget.usageUsd,
      monthlyLimitUsd: budget.monthlyLimitUsd,
      rolloverUsd: budget.rolloverUsd,
      remainingUsd: budget.remainingUsd,
      projectsBuilt,
    },
  });
});

export { usersRouter };
