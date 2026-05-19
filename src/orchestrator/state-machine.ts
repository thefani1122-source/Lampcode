import { z } from "zod";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const phaseSchema = z.enum([
  "IDLE",
  "PLANNING",
  "FOUNDATION",
  "BUILD",
  "VERIFY",
  "DEPLOY",
]);
export type Phase = z.infer<typeof phaseSchema>;

export const agentTypeSchema = z.enum([
  "architect",
  "backend",
  "frontend",
  "database",
  "devops",
]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const agentStatusSchema = z.enum([
  "idle",
  "running",
  "complete",
  "failed",
  "skipped",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const sessionStatusSchema = z.enum(["active", "paused", "complete", "failed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// ── Per-agent state ───────────────────────────────────────────────────────────

export const agentStateSchema = z.object({
  status: agentStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  creditsUsed: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type AgentState = z.infer<typeof agentStateSchema>;

// ── Phase history ─────────────────────────────────────────────────────────────

export const phaseHistoryEntrySchema = z.object({
  phase: phaseSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type PhaseHistoryEntry = z.infer<typeof phaseHistoryEntrySchema>;

// ── Full session state (as stored in Redis) ───────────────────────────────────

export const buildSessionSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string(),
  userId: z.string(),
  mode: z.enum(["fast", "plan"]),
  prompt: z.string(),
  phase: phaseSchema,
  status: sessionStatusSchema,
  agentStates: z.record(z.string(), agentStateSchema),
  phaseHistory: z.array(phaseHistoryEntrySchema),
  creditsUsed: z.number().nonnegative(),
  pausedAt: z.string().datetime().optional(),
  jobId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BuildSession = z.infer<typeof buildSessionSchema>;

// ── Phase definitions ─────────────────────────────────────────────────────────

export interface PhaseDefinition {
  readonly allowedTransitions: readonly Phase[];
  readonly requiredAgents: readonly AgentType[];
  readonly isParallel: boolean;
  readonly maxDurationMinutes: number;
}

export const PHASE_DEFINITIONS: Record<Phase, PhaseDefinition> = {
  IDLE: {
    allowedTransitions: ["PLANNING"],
    requiredAgents: [],
    isParallel: false,
    maxDurationMinutes: 0,
  },
  PLANNING: {
    allowedTransitions: ["FOUNDATION", "IDLE"],
    requiredAgents: ["architect"],
    isParallel: false,
    maxDurationMinutes: 10,
  },
  FOUNDATION: {
    allowedTransitions: ["BUILD", "IDLE"],
    requiredAgents: ["architect", "database"],
    isParallel: true,
    maxDurationMinutes: 30,
  },
  BUILD: {
    allowedTransitions: ["VERIFY", "IDLE"],
    requiredAgents: ["backend", "frontend"],
    isParallel: true,
    maxDurationMinutes: 60,
  },
  VERIFY: {
    allowedTransitions: ["DEPLOY", "BUILD", "IDLE"],
    requiredAgents: ["devops"],
    isParallel: false,
    maxDurationMinutes: 20,
  },
  DEPLOY: {
    allowedTransitions: ["IDLE"],
    requiredAgents: ["devops"],
    isParallel: false,
    maxDurationMinutes: 30,
  },
};

// ── Transition validation ─────────────────────────────────────────────────────

export interface TransitionResult {
  valid: boolean;
  reason?: string | undefined;
}

export function validateTransition(from: Phase, to: Phase): TransitionResult {
  const def = PHASE_DEFINITIONS[from];
  if (!(def.allowedTransitions as readonly string[]).includes(to)) {
    return {
      valid: false,
      reason: `Cannot transition ${from} → ${to}. Allowed: [${def.allowedTransitions.join(", ")}]`,
    };
  }
  return { valid: true };
}

export function getPhaseTimeout(phase: Phase): number {
  return PHASE_DEFINITIONS[phase].maxDurationMinutes * 60 * 1000;
}
