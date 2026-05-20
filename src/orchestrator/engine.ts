import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createRedis } from "../lib/redis.js";
import { z } from "zod";
import {
  phaseSchema,
  buildSessionSchema,
  validateTransition,
  PHASE_DEFINITIONS,
  type Phase,
  type BuildSession,
  type AgentState,
} from "./state-machine.js";
import { logger } from "../server/logger.js";

// ── Job payload ───────────────────────────────────────────────────────────────

const phaseJobDataSchema = z.object({
  sessionId: z.string().uuid(),
  phase: phaseSchema,
  projectId: z.string(),
  userId: z.string(),
});
type PhaseJobData = z.infer<typeof phaseJobDataSchema>;

// ── Agent runner interface (implemented by actual agents later) ───────────────

export interface AgentResult {
  success: boolean;
  creditsUsed: number;
  outputs: Record<string, unknown>;
  error?: string | undefined;
}

export interface AgentRunner {
  run(sessionId: string, phase: Phase, context: BuildContext): Promise<AgentResult>;
}

export interface BuildContext {
  projectId: string;
  userId: string;
  mode: "fast" | "plan";
  prompt: string;
}

/**
 * Minimal event sink the orchestrator fires into — decoupled from the WS layer.
 * The WebSocketServer satisfies this via makeOrchestratorEmitter().
 * All methods are fire-and-forget; failures must be swallowed by the implementor.
 */
export interface BuildEmitter {
  onBuildStart(sessionId: string, projectId: string, mode: "fast" | "plan"): void;
  onPhaseStart(sessionId: string, phase: Phase, agents: readonly string[], isParallel: boolean): void;
  onPhaseComplete(sessionId: string, phase: Phase, nextPhase: Phase | null, creditsUsed: number): void;
  onAgentStart(sessionId: string, agentType: string, taskName: string): void;
  onAgentComplete(sessionId: string, agentType: string, creditsUsed: number, filesModified: string[]): void;
  onAgentError(sessionId: string, agentType: string, error: string): void;
  onBuildComplete(sessionId: string, userId: string, projectId: string, creditsUsed: number): void;
  onBuildFailed(sessionId: string, phase: Phase, reason: string): void;
  onCreditBurn(sessionId: string, userId: string, creditsUsed: number, totalCreditsUsed: number): void;
  onProgress(sessionId: string, percent: number, message: string): void;
}

// ── Status response ───────────────────────────────────────────────────────────

export interface BuildStatus {
  sessionId: string;
  projectId: string;
  phase: Phase;
  status: BuildSession["status"];
  agentStates: BuildSession["agentStates"];
  phaseHistory: BuildSession["phaseHistory"];
  creditsUsed: number;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string | undefined;
}

// ── Redis keys ────────────────────────────────────────────────────────────────

const SESSION_KEY = (id: string) => `bf:session:${id}`;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const QUEUE_NAME = "build-phases";

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class BuildOrchestrator {
  private readonly stateRedis: Redis;
  private readonly queue: Queue<PhaseJobData>;
  private worker: Worker<PhaseJobData> | null = null;
  private agentRunner: AgentRunner | null = null;
  private readonly emitter: BuildEmitter | null;

  constructor(_redisUrl?: string, emitter?: BuildEmitter) {
    this.emitter = emitter ?? null;
    // Separate connections: BullMQ requires maxRetriesPerRequest: null
    this.stateRedis = createRedis();

    this.queue = new Queue<PhaseJobData>(QUEUE_NAME, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });
  }

  // ── Worker startup ──────────────────────────────────────────────────────────

  startWorker(_redisUrl?: string, runner?: AgentRunner): void {
    if (runner) this.agentRunner = runner;
    this.worker = new Worker<PhaseJobData>(
      QUEUE_NAME,
      (job) => this.processPhaseJob(job),
      {
        connection: createRedis(),
        concurrency: 5,
      },
    );

    this.worker.on("completed", (job) => {
      logger.info({ sessionId: job.data.sessionId, phase: job.data.phase }, "Phase job completed");
    });

    this.worker.on("failed", (job, err) => {
      const sid = job?.data.sessionId ?? "unknown";
      logger.error({ sessionId: sid, err }, "Phase job failed");
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async startBuild(
    projectId: string,
    userId: string,
    mode: "fast" | "plan",
    prompt: string,
  ): Promise<string> {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const session: BuildSession = {
      sessionId,
      projectId,
      userId,
      mode,
      prompt,
      phase: "IDLE",
      status: "active",
      agentStates: {},
      phaseHistory: [],
      creditsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.writeSession(session);

    this.emitter?.onBuildStart(sessionId, projectId, mode);

    // Kick off into PLANNING
    await this.transitionPhase(sessionId, "IDLE", "PLANNING");

    logger.info({ sessionId, projectId, mode }, "Build started");
    return sessionId;
  }

  async getStatus(sessionId: string): Promise<BuildStatus> {
    const session = await this.readSession(sessionId);
    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      phase: session.phase,
      status: session.status,
      agentStates: session.agentStates,
      phaseHistory: session.phaseHistory,
      creditsUsed: session.creditsUsed,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.pausedAt !== undefined ? { pausedAt: session.pausedAt } : {}),
    };
  }

  async transitionPhase(sessionId: string, from: Phase, to: Phase): Promise<void> {
    const session = await this.readSession(sessionId);

    if (session.phase !== from) {
      throw new Error(
        `Phase mismatch: session is in ${session.phase}, expected ${from}`,
      );
    }

    const { valid, reason } = validateTransition(from, to);
    if (!valid) {
      throw new Error(reason ?? `Invalid transition ${from} → ${to}`);
    }

    const now = new Date().toISOString();

    // Close out the current phase in history
    const updatedHistory = session.phaseHistory.map((entry) => {
      if (entry.phase === from && entry.completedAt === undefined) {
        const startMs = new Date(entry.startedAt).getTime();
        const endMs = new Date(now).getTime();
        return { ...entry, completedAt: now, durationMs: endMs - startMs };
      }
      return entry;
    });

    // Add the new phase entry (skip for IDLE — it has no work)
    if (to !== "IDLE") {
      updatedHistory.push({ phase: to, startedAt: now });
    }

    const updated: BuildSession = {
      ...session,
      phase: to,
      status: to === "IDLE" ? "complete" : "active",
      phaseHistory: updatedHistory,
      updatedAt: now,
    };

    await this.writeSession(updated);

    if (to === "IDLE") {
      // Build complete — arriving at IDLE means all phases done
      this.emitter?.onBuildComplete(
        sessionId,
        session.userId,
        session.projectId,
        updated.creditsUsed,
      );
    } else {
      const phaseDef = PHASE_DEFINITIONS[to];
      this.emitter?.onPhaseStart(
        sessionId,
        to,
        phaseDef.requiredAgents as unknown as readonly string[],
        phaseDef.isParallel,
      );

      const job = await this.queue.add(
        to,
        { sessionId, phase: to, projectId: session.projectId, userId: session.userId },
        { jobId: `${sessionId}:${to}:${Date.now()}` },
      );

      // Store job ID for pause/resume
      await this.writeSession({ ...updated, jobId: job.id });
    }

    logger.info({ sessionId, from, to }, "Phase transition");
  }

  async pauseBuild(sessionId: string): Promise<void> {
    const session = await this.readSession(sessionId);
    if (session.status !== "active") {
      throw new Error(`Cannot pause session in status: ${session.status}`);
    }

    const now = new Date().toISOString();
    await this.writeSession({ ...session, status: "paused", pausedAt: now, updatedAt: now });

    // Drain pending jobs for this session
    await this.queue.pause();
    logger.info({ sessionId }, "Build paused");
  }

  async resumeBuild(sessionId: string): Promise<void> {
    const session = await this.readSession(sessionId);
    if (session.status !== "paused") {
      throw new Error(`Cannot resume session in status: ${session.status}`);
    }

    const now = new Date().toISOString();
    const resumed: BuildSession = {
      ...session,
      status: "active",
      updatedAt: now,
    };
    // Clear pausedAt by omitting it from the spread
    delete (resumed as Partial<BuildSession>).pausedAt;

    await this.writeSession(resumed);
    await this.queue.resume();

    // Re-enqueue the current phase
    const currentPhase = session.phase;
    if (currentPhase !== "IDLE") {
      await this.queue.add(
        currentPhase,
        {
          sessionId,
          phase: currentPhase,
          projectId: session.projectId,
          userId: session.userId,
        },
        { jobId: `${sessionId}:${currentPhase}:resume:${Date.now()}` },
      );
    }

    logger.info({ sessionId, phase: session.phase }, "Build resumed");
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.worker?.close();
    this.stateRedis.disconnect();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async readSession(sessionId: string): Promise<BuildSession> {
    const raw = await this.stateRedis.get(SESSION_KEY(sessionId));
    if (raw === null) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return buildSessionSchema.parse(JSON.parse(raw));
  }

  private async writeSession(session: BuildSession): Promise<void> {
    const validated = buildSessionSchema.parse(session);
    await this.stateRedis.set(
      SESSION_KEY(session.sessionId),
      JSON.stringify(validated),
      "EX",
      SESSION_TTL_SECONDS,
    );
  }

  private async processPhaseJob(job: Job<PhaseJobData>): Promise<void> {
    const data = phaseJobDataSchema.parse(job.data);
    const { sessionId, phase } = data;

    const session = await this.readSession(sessionId);

    // Skip paused sessions — they'll be re-queued on resume
    if (session.status === "paused") {
      logger.info({ sessionId, phase }, "Skipping job: session is paused");
      return;
    }

    const phaseDef = PHASE_DEFINITIONS[phase];
    const runner = this.agentRunner;

    if (runner === null) {
      throw new Error("No agent runner registered");
    }

    const context: BuildContext = {
      projectId: session.projectId,
      userId: session.userId,
      mode: session.mode,
      prompt: session.prompt,
    };

    const agentStates = { ...session.agentStates };

    const totalAgents = phaseDef.requiredAgents.length;
    let completedAgents = 0;

    const runAgent = async (agentType: string): Promise<{ agentType: string; result: AgentResult }> => {
      const taskName = `${phase}:${agentType}`;
      this.emitter?.onAgentStart(sessionId, agentType, taskName);

      const startMs = Date.now();
      const startedAt = new Date().toISOString();
      agentStates[agentType] = { status: "running", startedAt, creditsUsed: 0 };

      const result = await runner.run(sessionId, phase, context);
      const durationMs = Date.now() - startMs;
      const completedAt = new Date().toISOString();

      agentStates[agentType] = {
        status: result.success ? "complete" : "failed",
        startedAt,
        completedAt,
        creditsUsed: result.creditsUsed,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };

      const filesModified = typeof result.outputs["outputPath"] === "string"
        ? [result.outputs["outputPath"]]
        : [];

      if (result.success) {
        this.emitter?.onAgentComplete(sessionId, agentType, result.creditsUsed, filesModified);
        completedAgents++;
        const totalSoFar = session.creditsUsed + result.creditsUsed;
        this.emitter?.onCreditBurn(sessionId, session.userId, result.creditsUsed, totalSoFar);
        const pct = Math.round((completedAgents / totalAgents) * 100);
        this.emitter?.onProgress(sessionId, pct, `${agentType} complete (${durationMs}ms)`);
      } else {
        this.emitter?.onAgentError(sessionId, agentType, result.error ?? "Unknown error");
      }

      return { agentType, result };
    };

    if (phaseDef.isParallel) {
      // Run all required agents concurrently
      const results = await Promise.allSettled(
        phaseDef.requiredAgents.map((agentType) => runAgent(agentType)),
      );

      const anyFailed = results.some((r) => r.status === "rejected");
      if (anyFailed) {
        const failReason = `One or more parallel agents failed in phase ${phase}`;
        await this.writeSession({
          ...session,
          agentStates,
          status: "failed",
          updatedAt: new Date().toISOString(),
        });
        this.emitter?.onBuildFailed(sessionId, phase, failReason);
        throw new Error(failReason);
      }
    } else {
      // Run required agents sequentially
      for (const agentType of phaseDef.requiredAgents) {
        const { result } = await runAgent(agentType);

        if (!result.success) {
          const failReason = `Agent ${agentType} failed in phase ${phase}`;
          await this.writeSession({
            ...session,
            agentStates,
            status: "failed",
            updatedAt: new Date().toISOString(),
          });
          this.emitter?.onBuildFailed(sessionId, phase, failReason);
          throw new Error(failReason);
        }
      }
    }

    // Compute total credits from this phase
    const phaseCredits = Object.values(agentStates).reduce(
      (sum: number, s: AgentState) => sum + s.creditsUsed,
      0,
    );

    const newTotal = session.creditsUsed + phaseCredits;

    await this.writeSession({
      ...session,
      agentStates,
      creditsUsed: newTotal,
      updatedAt: new Date().toISOString(),
    });

    this.emitter?.onPhaseComplete(sessionId, phase, null, newTotal);

    logger.info({ sessionId, phase, phaseCredits }, "Phase job finished");
  }
}
