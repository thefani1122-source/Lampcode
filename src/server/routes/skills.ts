import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import { userSkills } from "../../db/schema.js";
import { parseUserSkillPackage } from "../../agents/user-skills.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";

export const skillsRouter = new Hono();
skillsRouter.use("/*", requireAuth);

const createSkillSchema = z.object({
  skillMd: z.string().min(1).max(48 * 1024),
  resources: z.record(z.string(), z.string()).optional(),
});

const updateSkillStateSchema = z.object({
  enabled: z.boolean(),
});

const updateSkillDocumentSchema = z.object({
  skillMd: z.string().min(1).max(48 * 1024),
  resources: z.record(z.string(), z.string()).optional(),
});

function parseSkillOrThrow(skillMd: string, resources: Record<string, string> = {}) {
  try {
    return parseUserSkillPackage(skillMd, resources);
  } catch (error) {
    throw new AppError(
      400,
      error instanceof Error ? error.message : "Invalid SKILL.md document.",
      "INVALID_SKILL",
    );
  }
}

// GET /api/skills — metadata only; skill bodies are loaded by the agent on demand.
skillsRouter.get("/", async (c) => {
  const { id: userId } = c.get("authUser");
  const rows = await db
    .select({
      id: userSkills.id,
      slug: userSkills.slug,
      name: userSkills.name,
      description: userSkills.description,
      version: userSkills.version,
      revision: userSkills.revision,
      enabled: userSkills.enabled,
      source: userSkills.source,
      contentHash: userSkills.contentHash,
      createdAt: userSkills.createdAt,
      updatedAt: userSkills.updatedAt,
    })
    .from(userSkills)
    .where(eq(userSkills.userId, userId))
    .orderBy(desc(userSkills.updatedAt))
    .limit(200);

  return c.json({
    skills: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
});


// GET /api/skills/:id — return the full document only to its owner for editing.
skillsRouter.get("/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const id = c.req.param("id");
  const rows = await db
    .select({
      id: userSkills.id,
      slug: userSkills.slug,
      name: userSkills.name,
      description: userSkills.description,
      version: userSkills.version,
      revision: userSkills.revision,
      enabled: userSkills.enabled,
      contentHash: userSkills.contentHash,
      content: userSkills.content,
      resources: userSkills.resources,
      updatedAt: userSkills.updatedAt,
    })
    .from(userSkills)
    .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
    .limit(1);

  const skill = rows[0];
  if (!skill) throw new AppError(404, "Skill not found.", "NOT_FOUND");
  return c.json({
    skill: {
      ...skill,
      updatedAt: skill.updatedAt.toISOString(),
    },
  });
});

// POST /api/skills — install one standard SKILL.md file into the user's library.
skillsRouter.post("/", async (c) => {
  const { id: userId } = c.get("authUser");
  const raw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body.", "VALIDATION_ERROR");
  });
  const parsedBody = createSkillSchema.safeParse(raw);
  if (!parsedBody.success) {
    throw new AppError(400, parsedBody.error.issues[0]?.message ?? "Invalid SKILL.md content.", "VALIDATION_ERROR");
  }
  const parsed = parseSkillOrThrow(parsedBody.data.skillMd, parsedBody.data.resources ?? {});

  const userSkillRows = await db
    .select({ id: userSkills.id })
    .from(userSkills)
    .where(eq(userSkills.userId, userId))
    .limit(100);
  if (userSkillRows.length >= 100) {
    throw new AppError(409, "Your Skills Library is limited to 100 installed skills.", "SKILL_LIMIT_REACHED");
  }

  const existing = await db
    .select({ id: userSkills.id })
    .from(userSkills)
    .where(and(eq(userSkills.userId, userId), eq(userSkills.slug, parsed.slug)))
    .limit(1);
  if (existing.length > 0) {
    throw new AppError(409, "This skill is already in your library. Remove it before importing a replacement.", "SKILL_ALREADY_INSTALLED");
  }

  const now = new Date();
  const inserted = await db
    .insert(userSkills)
    .values({
      id: randomUUID(),
      userId,
      slug: parsed.slug,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      revision: 1,
      content: parsed.normalizedContent,
      resources: parsed.resources,
      contentHash: parsed.contentHash,
      source: "manual",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userSkills.userId, userSkills.slug] })
    .returning({
      id: userSkills.id,
      slug: userSkills.slug,
      name: userSkills.name,
      description: userSkills.description,
      version: userSkills.version,
      revision: userSkills.revision,
      enabled: userSkills.enabled,
    });

  if (!inserted[0]) {
    throw new AppError(409, "This skill was added in another request. Refresh your library.", "SKILL_ALREADY_INSTALLED");
  }

  return c.json({ skill: inserted[0] }, 201);
});

// PUT /api/skills/:id — replace an installed document without uninstalling it.
// The stable slug is immutable because it is part of the agent-facing identifier.
skillsRouter.put("/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body.", "VALIDATION_ERROR");
  });
  const parsedBody = updateSkillDocumentSchema.safeParse(raw);
  if (!parsedBody.success) {
    throw new AppError(400, parsedBody.error.issues[0]?.message ?? "Invalid SKILL.md content.", "VALIDATION_ERROR");
  }
  const existingRows = await db
    .select({
      slug: userSkills.slug,
      revision: userSkills.revision,
      enabled: userSkills.enabled,
      contentHash: userSkills.contentHash,
      resources: userSkills.resources,
    })
    .from(userSkills)
    .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError(404, "Skill not found.", "NOT_FOUND");
  const parsed = parseSkillOrThrow(parsedBody.data.skillMd, parsedBody.data.resources ?? existing.resources ?? {});
  if (parsed.slug !== existing.slug) {
    throw new AppError(400, "A skill's name cannot be changed after installation. Keep the original name in SKILL.md.", "SKILL_NAME_IMMUTABLE");
  }

  if (parsed.contentHash === existing.contentHash) {
    return c.json({
      skill: {
        id,
        slug: existing.slug,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        revision: existing.revision,
        enabled: existing.enabled,
        contentHash: parsed.contentHash,
      },
      unchanged: true,
    });
  }

  const rows = await db
    .update(userSkills)
    .set({
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      content: parsed.normalizedContent,
      resources: parsed.resources,
      contentHash: parsed.contentHash,
      revision: sql`${userSkills.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
    .returning({
      id: userSkills.id,
      slug: userSkills.slug,
      name: userSkills.name,
      description: userSkills.description,
      version: userSkills.version,
      revision: userSkills.revision,
      enabled: userSkills.enabled,
      contentHash: userSkills.contentHash,
    });
  if (!rows[0]) throw new AppError(404, "Skill not found.", "NOT_FOUND");
  return c.json({ skill: rows[0], unchanged: false });
});

// PATCH /api/skills/:id — enable/disable without deleting the installed skill.
skillsRouter.patch("/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body.", "VALIDATION_ERROR");
  });
  const parsed = updateSkillStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid skill settings.", "VALIDATION_ERROR");
  }

  const rows = await db
    .update(userSkills)
    .set({ enabled: parsed.data.enabled, updatedAt: new Date() })
    .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
    .returning({ id: userSkills.id, slug: userSkills.slug, enabled: userSkills.enabled });
  if (!rows[0]) throw new AppError(404, "Skill not found.", "NOT_FOUND");
  return c.json({ skill: rows[0] });
});

// DELETE /api/skills/:id — remove only the authenticated user's skill.
skillsRouter.delete("/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const id = c.req.param("id");
  const rows = await db
    .delete(userSkills)
    .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
    .returning({ id: userSkills.id });
  if (!rows[0]) throw new AppError(404, "Skill not found.", "NOT_FOUND");
  return c.json({ success: true });
});
