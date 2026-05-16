import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { user as userTable, buildJobs } from "../../db/schema.js";
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

// GET /api/users/me/usage — build job usage stats
usersRouter.get("/me/usage", async (c) => {
  const authUser = c.get("authUser");

  const stats = await db
    .select({
      status: buildJobs.status,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(buildJobs)
    .where(eq(buildJobs.userId, authUser.id))
    .groupBy(buildJobs.status);

  const total = stats.reduce((sum, row) => sum + row.count, 0);
  const byStatus = Object.fromEntries(stats.map((r) => [r.status, r.count]));

  return c.json({ usage: { total, byStatus } });
});

export { usersRouter };
