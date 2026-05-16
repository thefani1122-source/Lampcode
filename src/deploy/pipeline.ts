import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { buildSessions, projects, integrations } from "../db/schema.js";
import { logger } from "../server/logger.js";
import { getGateway } from "../mcp/gateway.js";
import { runSmokeTests } from "./smoke.js";
import { getWebSocketServer } from "../websocket/server.js";
import {
  type DeployResult,
  type DeployStatus,
  type DeployStep,
} from "../mcp/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

async function loadSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(buildSessions)
    .where(and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, userId)))
    .limit(1);
  const s = rows[0];
  if (!s) throw new Error(`Build session ${sessionId} not found`);
  return s;
}

async function loadProject(projectId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const p = rows[0];
  if (!p) throw new Error(`Project ${projectId} not found`);
  return p;
}

function collectCliCommands(steps: DeployStep[]): string[] {
  return steps.flatMap((s) => s.cliCommands ?? []);
}

// ── DeployPipeline ────────────────────────────────────────────────────────────

export class DeployPipeline {
  private readonly gateway = getGateway();

  // ── Full deploy ──────────────────────────────────────────────────────────

  /**
   * Orchestrate a full deployment:
   *   1. Push env vars → Vercel + Railway
   *   2. Push database migrations → Supabase
   *   3. Push code → GitHub
   *   4. Trigger deploy → Vercel
   *   5. Run smoke tests
   *   6. Rollback on failure
   */
  async deploy(sessionId: string, userId: string): Promise<DeployResult> {
    const session = await loadSession(sessionId, userId);
    const { projectId } = session;
    const project = await loadProject(projectId);

    logger.info({ sessionId, projectId }, "Deploy pipeline starting");
    const server = ws();
    server?.progress(sessionId, { sessionId, percent: 5, message: "Starting deployment", timestamp: now() });

    const steps: DeployStep[] = [];

    // ── Step 1: Set env vars ───────────────────────────────────────────────
    const envVars = (project.settings?.envVars ?? {}) as Record<string, string>;
    const envResult = await this.setEnvVars(projectId, envVars);
    steps.push({ ...envResult, name: "Set env vars (Vercel)" });
    server?.progress(sessionId, { sessionId, percent: 20, message: "Env vars pushed", timestamp: now() });

    // ── Step 2: Push database ──────────────────────────────────────────────
    const dbResult = await this.pushDatabase(projectId);
    steps.push({ ...dbResult, name: "Push database (Supabase)" });
    server?.progress(sessionId, { sessionId, percent: 45, message: "Database updated", timestamp: now() });

    // ── Step 3: Push code ──────────────────────────────────────────────────
    const codeResult = await this.pushCode(projectId);
    steps.push({ ...codeResult, name: "Push code (GitHub)" });
    server?.progress(sessionId, { sessionId, percent: 65, message: "Code pushed", timestamp: now() });

    // ── Step 4: Deploy ─────────────────────────────────────────────────────
    const deployResult = await this.gateway.executeTool(
      projectId,
      "vercel",
      "deploy",
      { projectName: project.slug },
    );
    const deployStep: DeployStep = {
      name: "Deploy (Vercel)",
      tier: deployResult.tier,
      success: deployResult.success,
      data: deployResult.data,
      ...(deployResult.cliCommands !== undefined ? { cliCommands: deployResult.cliCommands } : {}),
      ...(deployResult.error !== undefined ? { error: deployResult.error } : {}),
    };
    steps.push(deployStep);
    server?.progress(sessionId, { sessionId, percent: 80, message: "Deployment triggered", timestamp: now() });

    // Determine overall status
    const allManual = steps.every((s) => s.tier === 3);
    const anyFailed = steps.some((s) => !s.success);

    if (anyFailed) {
      // Attempt rollback of any automatic steps
      await this.rollback(projectId).catch((e: unknown) =>
        logger.warn({ projectId, err: e }, "Rollback failed"),
      );
      await db
        .update(buildSessions)
        .set({ status: "failed", planStatus: "failed", completedAt: new Date() })
        .where(eq(buildSessions.id, sessionId));

      return {
        sessionId,
        projectId,
        status: "failed",
        steps,
        manualSteps: collectCliCommands(steps),
      };
    }

    // ── Step 5: Smoke tests ────────────────────────────────────────────────
    let smokeTests: Awaited<ReturnType<typeof runSmokeTests>> | undefined;
    const previewUrl = deployResult.data["url"] as string | undefined;

    if (!allManual && previewUrl) {
      server?.progress(sessionId, { sessionId, percent: 90, message: "Running smoke tests", timestamp: now() });
      smokeTests = await runSmokeTests(previewUrl);
      logger.info({ sessionId, previewUrl, ok: smokeTests.ok }, "Smoke tests complete");
    }

    const status: DeployStatus = allManual
      ? "manual_required"
      : smokeTests?.ok === false
      ? "failed"
      : "deployed";

    // Update session
    await db
      .update(buildSessions)
      .set({
        status: status === "deployed" ? "success" : status === "failed" ? "failed" : "running",
        previewUrl: previewUrl ?? null,
        completedAt: status !== "manual_required" ? new Date() : undefined,
        planStatus: status === "deployed" ? "complete" : undefined,
      })
      .where(eq(buildSessions.id, sessionId));

    if (previewUrl) {
      await db
        .update(integrations)
        .set({ lastDeployedAt: new Date() })
        .where(and(
          eq(integrations.projectId, projectId),
          eq(integrations.provider, "vercel"),
        ));
    }

    server?.progress(sessionId, { sessionId, percent: 100, message: `Deploy ${status}`, timestamp: now() });

    return {
      sessionId,
      projectId,
      status,
      previewUrl,
      steps,
      ...(smokeTests !== undefined ? { smokeTests } : {}),
      ...(allManual ? { manualSteps: collectCliCommands(steps) } : {}),
    };
  }

  // ── Set env vars ─────────────────────────────────────────────────────────

  async setEnvVars(
    projectId: string,
    env: Record<string, string>,
  ): Promise<DeployStep> {
    const result = await this.gateway.executeTool(projectId, "vercel", "setEnvVars", {
      projectName: projectId,
      envVars: env,
    });
    return {
      name: "Set env vars",
      tier: result.tier,
      success: result.success,
      data: result.data,
      ...(result.cliCommands !== undefined ? { cliCommands: result.cliCommands } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  // ── Push database ────────────────────────────────────────────────────────

  async pushDatabase(projectId: string, sql = ""): Promise<DeployStep> {
    const result = await this.gateway.executeTool(projectId, "supabase", "pushMigrations", {
      sql: sql || "-- No migrations provided",
      projectRef: projectId,
    });
    return {
      name: "Push database",
      tier: result.tier,
      success: result.success,
      data: result.data,
      ...(result.cliCommands !== undefined ? { cliCommands: result.cliCommands } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  // ── Push code ────────────────────────────────────────────────────────────

  async pushCode(projectId: string, branch = "main"): Promise<DeployStep> {
    const result = await this.gateway.executeTool(projectId, "github", "pushCode", {
      repo: projectId,
      branch,
      message: `deploy: BuildForge automated push`,
      files: [],
    });
    return {
      name: "Push code",
      tier: result.tier,
      success: result.success,
      data: result.data,
      ...(result.cliCommands !== undefined ? { cliCommands: result.cliCommands } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  // ── Rollback ─────────────────────────────────────────────────────────────

  async rollback(projectId: string, deploymentId?: string): Promise<DeployStep> {
    const project = await loadProject(projectId);
    const result = await this.gateway.executeTool(projectId, "vercel", "rollback", {
      projectName: project.slug,
      ...(deploymentId !== undefined ? { deploymentId } : {}),
    });
    logger.info({ projectId, deploymentId }, "Rollback triggered");
    return {
      name: "Rollback",
      tier: result.tier,
      success: result.success,
      data: result.data,
      ...(result.cliCommands !== undefined ? { cliCommands: result.cliCommands } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _pipeline: DeployPipeline | null = null;

export function getDeployPipeline(): DeployPipeline {
  if (_pipeline === null) _pipeline = new DeployPipeline();
  return _pipeline;
}
