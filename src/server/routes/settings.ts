import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  projects,
  userPreferences,
  type ProjectSettings,
  type ProjectBranding,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";

// ── Validation ────────────────────────────────────────────────────────────────

const projectSettingsPatchSchema = z.object({
  buildCommand:  z.string().max(500).optional(),
  outputDir:     z.string().max(200).optional(),
  nodeVersion:   z.string().max(20).optional(),
  envVars:       z.record(z.string(), z.string()).optional(),
}).strict();

const projectBrandingPatchSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour").optional(),
  logoUrl:      z.string().url().optional(),
  faviconUrl:   z.string().url().optional(),
}).strict();

const settingsPatchSchema = z.object({
  settings: projectSettingsPatchSchema.optional(),
  branding:  projectBrandingPatchSchema.optional(),
}).strict();

const preferencesPatchSchema = z.object({
  theme:               z.enum(["light", "dark", "system"]).optional(),
  emailNotifications:  z.boolean().optional(),
  buildNotifications:  z.boolean().optional(),
  weeklyDigest:        z.boolean().optional(),
  defaultModel:        z.string().max(100).optional(),
  timezone:            z.string().max(100).optional(),
}).strict();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectOwner(projectId: string, userId: string) {
  const rows = await db
    .select({ id: projects.id, settings: projects.settings, branding: projects.branding, slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(403, "Not authorized", "FORBIDDEN");
  return rows[0];
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(400, r.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  return r.data;
}

// ── Project settings router (mounted at /api/projects/:id/settings) ───────────

export const settingsRouter = new Hono();
settingsRouter.use("/*", requireAuth);

// GET /api/projects/:id/settings
settingsRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  const project = await requireProjectOwner(projectId, authUser.id);

  return c.json({
    projectId,
    settings: project.settings ?? {},
    branding:  project.branding  ?? {},
  });
});

// PATCH /api/projects/:id/settings
settingsRouter.patch("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  const project = await requireProjectOwner(projectId, authUser.id);

  const body = parseBody(settingsPatchSchema, await c.req.json().catch(() => ({})));

  const newSettings: ProjectSettings = {
    ...((project.settings ?? {}) as ProjectSettings),
    ...(body.settings ?? {}),
  };
  const newBranding: ProjectBranding = {
    ...((project.branding ?? {}) as ProjectBranding),
    ...(body.branding ?? {}),
  };

  const [updated] = await db
    .update(projects)
    .set({ settings: newSettings, branding: newBranding, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning({ settings: projects.settings, branding: projects.branding });

  return c.json({ projectId, settings: updated?.settings ?? {}, branding: updated?.branding ?? {} });
});

// ── User preferences router (mounted at /api/users/me/settings) ───────────────

export const userSettingsRouter = new Hono();
userSettingsRouter.use("/*", requireAuth);

const PREF_DEFAULTS = {
  theme:               "system",
  emailNotifications:  true,
  buildNotifications:  true,
  weeklyDigest:        false,
  defaultModel:        null,
  timezone:            null,
} as const;

// GET /api/users/me/settings
userSettingsRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, authUser.id))
    .limit(1);

  const prefs = rows[0] ?? { userId: authUser.id, ...PREF_DEFAULTS, updatedAt: new Date() };
  return c.json({ preferences: prefs });
});

// PATCH /api/users/me/settings
userSettingsRouter.patch("/", async (c) => {
  const authUser = c.get("authUser");
  const body = parseBody(preferencesPatchSchema, await c.req.json().catch(() => ({})));

  // Build update payload — only include provided fields
  type PrefUpdate = {
    updatedAt: Date;
    theme?: string | undefined;
    emailNotifications?: boolean | undefined;
    buildNotifications?: boolean | undefined;
    weeklyDigest?: boolean | undefined;
    defaultModel?: string | null | undefined;
    timezone?: string | null | undefined;
  };

  const update: PrefUpdate = { updatedAt: new Date() };
  if (body.theme               !== undefined) update.theme               = body.theme;
  if (body.emailNotifications  !== undefined) update.emailNotifications  = body.emailNotifications;
  if (body.buildNotifications  !== undefined) update.buildNotifications  = body.buildNotifications;
  if (body.weeklyDigest        !== undefined) update.weeklyDigest        = body.weeklyDigest;
  if (body.defaultModel        !== undefined) update.defaultModel        = body.defaultModel;
  if (body.timezone            !== undefined) update.timezone            = body.timezone;

  // Upsert — insert on first call, update thereafter
  const existing = await db
    .select({ userId: userPreferences.userId })
    .from(userPreferences)
    .where(eq(userPreferences.userId, authUser.id))
    .limit(1);

  if (existing.length === 0) {
    const [inserted] = await db
      .insert(userPreferences)
      .values({
        userId: authUser.id,
        theme:               (body.theme ?? PREF_DEFAULTS.theme) as string,
        emailNotifications:  body.emailNotifications  ?? PREF_DEFAULTS.emailNotifications,
        buildNotifications:  body.buildNotifications  ?? PREF_DEFAULTS.buildNotifications,
        weeklyDigest:        body.weeklyDigest        ?? PREF_DEFAULTS.weeklyDigest,
        defaultModel:        body.defaultModel        ?? undefined,
        timezone:            body.timezone            ?? undefined,
        updatedAt: new Date(),
      })
      .returning();
    return c.json({ preferences: inserted }, 201);
  }

  const [updated] = await db
    .update(userPreferences)
    .set(update)
    .where(eq(userPreferences.userId, authUser.id))
    .returning();

  return c.json({ preferences: updated });
});
