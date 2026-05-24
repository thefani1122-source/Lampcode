import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  projects,
  projectMembers,
  buildJobs,
  auditLog,
  type ProjectSettings,
  type ProjectBranding,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";

// ── Input schemas ─────────────────────────────────────────────────────────────

const projectSettingsSchema = z.object({
  buildCommand: z.string().optional(),
  outputDir: z.string().optional(),
  nodeVersion: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});

const projectBrandingSchema = z.object({
  primaryColor: z.string().optional(),
  logoUrl: z.string().url().optional(),
  faviconUrl: z.string().url().optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  mode: z.enum(["fast", "plan"]),
  techStack: z.array(z.string().max(50)).max(20).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  settings: projectSettingsSchema.nullable().optional(),
  branding: projectBrandingSchema.nullable().optional(),
  isArchived: z.boolean().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  return result.data;
}

function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "project";
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  let n = 0;
  for (;;) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1);
    if (rows.length === 0) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

async function writeAudit(
  userId: string,
  action: string,
  projectId: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    userId,
    projectId,
    action,
    metadata: metadata ?? null,
    createdAt: new Date(),
  });
}

async function ownerProject(projectId: string, userId: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (row === undefined) {
    throw new AppError(404, "Project not found", "NOT_FOUND");
  }
  return row;
}

// ── Router ────────────────────────────────────────────────────────────────────

const projectsRouter = new Hono();
projectsRouter.use("/*", requireAuth);

// GET /api/projects
projectsRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const showArchived = c.req.query("archived") === "true";

  const list = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      mode: projects.mode,
      status: projects.status,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(
      showArchived
        ? eq(projects.userId, authUser.id)
        : and(eq(projects.userId, authUser.id), eq(projects.isArchived, false)),
    )
    .orderBy(desc(projects.createdAt));

  return c.json({ projects: list });
});

// POST /api/projects
projectsRouter.post("/", async (c) => {
  const authUser = c.get("authUser");
  const body = parseBody(createProjectSchema, await c.req.json());

  const slug = await uniqueSlug(toSlug(body.name));

  const [project] = await db
    .insert(projects)
    .values({
      id: crypto.randomUUID(),
      userId: authUser.id,
      name: body.name,
      slug,
      description: body.description ?? null,
      mode: body.mode,
      status: "idle",
      techStack: body.techStack ?? [],
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  if (project === undefined) {
    throw new AppError(500, "Failed to create project", "INTERNAL_ERROR");
  }

  await writeAudit(authUser.id, "project.created", project.id, {
    name: project.name,
    mode: project.mode,
  });

  return c.json({ project }, 201);
});

// GET /api/projects/:id
projectsRouter.get("/:id", async (c) => {
  const authUser = c.get("authUser");
  const project = await ownerProject(c.req.param("id"), authUser.id);

  const [memberRow] = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, project.id));

  const [lastBuild] = await db
    .select({ status: buildJobs.status })
    .from(buildJobs)
    .where(eq(buildJobs.projectId, project.id))
    .orderBy(desc(buildJobs.createdAt))
    .limit(1);

  return c.json({
    project: {
      ...project,
      memberCount: memberRow?.count ?? 0,
      lastBuildStatus: lastBuild?.status ?? null,
    },
  });
});

// PATCH /api/projects/:id
projectsRouter.patch("/:id", async (c) => {
  const authUser = c.get("authUser");
  const project = await ownerProject(c.req.param("id"), authUser.id);
  const body = parseBody(updateProjectSchema, await c.req.json());

  type ProjectUpdate = {
    updatedAt: Date;
    name?: string;
    description?: string | null;
    settings?: ProjectSettings | null;
    branding?: ProjectBranding | null;
    isArchived?: boolean;
  };

  const updates: ProjectUpdate = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.settings !== undefined) updates.settings = body.settings;
  if (body.branding !== undefined) updates.branding = body.branding;
  if (body.isArchived !== undefined) updates.isArchived = body.isArchived;

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.id, project.id))
    .returning();

  if (updated === undefined) {
    throw new AppError(500, "Failed to update project", "INTERNAL_ERROR");
  }

  await writeAudit(authUser.id, "project.updated", project.id, {
    fields: Object.keys(updates).filter((k) => k !== "updatedAt"),
  });

  return c.json({ project: updated });
});

// DELETE /api/projects/:id — soft delete
projectsRouter.delete("/:id", async (c) => {
  const authUser = c.get("authUser");
  const project = await ownerProject(c.req.param("id"), authUser.id);

  await db
    .update(projects)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(eq(projects.id, project.id));

  await writeAudit(authUser.id, "project.archived", project.id, {
    name: project.name,
  });

  return c.json({ success: true });
});

// POST /api/projects/:id/duplicate
projectsRouter.post("/:id/duplicate", async (c) => {
  const authUser = c.get("authUser");
  const source = await ownerProject(c.req.param("id"), authUser.id);

  const newSlug = `${source.slug}-copy-${Date.now()}`;

  const [duplicate] = await db
    .insert(projects)
    .values({
      id: crypto.randomUUID(),
      userId: authUser.id,
      name: `${source.name} (Copy)`,
      slug: newSlug,
      description: source.description,
      mode: source.mode,
      status: "idle",
      techStack: source.techStack ?? [],
      settings: source.settings ?? {},
      branding: source.branding ?? {},
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  if (duplicate === undefined) {
    throw new AppError(500, "Failed to duplicate project", "INTERNAL_ERROR");
  }

  await writeAudit(authUser.id, "project.duplicated", duplicate.id, {
    sourceId: source.id,
    sourceName: source.name,
  });

  return c.json({ project: duplicate }, 201);
});

export { projectsRouter };
