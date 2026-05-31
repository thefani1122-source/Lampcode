import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { user as userTable, userBilling, buildSessions } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  image: z.string().url().nullable().optional(),
});

const usersRouter = new Hono();

// All user routes require authentication
usersRouter.use("/*", requireAuth);

// GET /api/users/me — current user profile
usersRouter.get("/me", async (c) => {
  const authUser = c.get("authUser");
  const [profile] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.id, authUser.id))
    .limit(1);

  if (profile === undefined) {
    return c.json({ error: { message: "User not found", code: "NOT_FOUND" } }, 404);
  }

  return c.json({ user: profile });
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

  const [billing, projectsBuiltRow] = await Promise.all([
    db
      .select({ creditsUsed: userBilling.creditsUsed, creditsLimit: userBilling.creditsLimit })
      .from(userBilling)
      .where(eq(userBilling.userId, authUser.id))
      .limit(1),
    db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(buildSessions)
      .where(eq(buildSessions.userId, authUser.id)),
  ]);

  const creditsUsed = billing[0]?.creditsUsed ?? 0;
  const creditsLimit = billing[0]?.creditsLimit ?? 500;
  const projectsBuilt = projectsBuiltRow[0]?.count ?? 0;

  return c.json({
    usage: {
      creditsUsed,
      creditsLimit,
      creditsRemaining: creditsLimit - creditsUsed,
      projectsBuilt,
    },
  });
});

export { usersRouter };
