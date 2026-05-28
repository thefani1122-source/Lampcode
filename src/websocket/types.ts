import { type StreamChunk } from "../agents/model-gateway.js";
type Phase = "IDLE" | "PLANNING" | "FOUNDATION" | "BUILD" | "VERIFY" | "DEPLOY";
import { type AgentTaskType } from "../agents/model-gateway.js";

// ── Build namespace events ────────────────────────────────────────────────────

export interface BuildStartEvent {
  sessionId: string;
  projectId: string;
  mode: "fast" | "plan";
  timestamp: string;
}

export interface PhaseStartEvent {
  sessionId: string;
  phase: Phase;
  agents: string[];
  isParallel: boolean;
  timestamp: string;
}

export interface CreditBurnEvent {
  sessionId: string;
  userId: string;
  creditsUsed: number;
  totalCreditsUsed: number;
  timestamp: string;
}

export interface AgentStartEvent {
  taskId: string;
  sessionId: string;
  agentType: AgentTaskType;
  taskName: string;
  model: string;
  tier: number;
  timestamp: string;
}

export interface AgentProgressEvent {
  taskId: string;
  sessionId: string;
  agentType: AgentTaskType;
  chunk: StreamChunk;
  tokensUsed: number;
  timestamp: string;
}

export interface AgentCompleteEvent {
  taskId: string;
  sessionId: string;
  agentType: AgentTaskType;
  taskName: string;
  outputPath: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface AgentErrorEvent {
  taskId: string;
  sessionId: string;
  agentType: AgentTaskType;
  error: string;
  timestamp: string;
}

export interface FileUpdateEvent {
  sessionId: string;
  path: string;
  content: string;
  diff?: string | undefined;
  linesChanged: number;
  timestamp: string;
}

export interface ProgressEvent {
  sessionId: string;
  percent: number;
  message: string;
  timestamp: string;
}

export interface PhaseCompleteEvent {
  sessionId: string;
  phase: Phase;
  nextPhase: Phase | null;
  creditsUsed: number;
  timestamp: string;
}

export interface BuildFailedEvent {
  sessionId: string;
  phase: Phase;
  reason: string;
  logs: string;
  timestamp: string;
}

export interface PlanPhaseStartEvent {
  sessionId: string;
  phase: string;
  agents: string[];
  isParallel: boolean;
  timestamp: string;
}

export interface VerifyResultEvent {
  sessionId: string;
  passed: boolean;
  round: number;
  report: {
    checks: Array<{ name: string; passed: boolean; severity?: string | undefined; detail: string }>;
  };
  timestamp: string;
}

export interface FixRequiredEvent {
  sessionId: string;
  failedChecks: string[];
  round: number;
  maxRounds: number;
  timestamp: string;
}

export interface DeployStartEvent {
  sessionId: string;
  target: string;
  timestamp: string;
}

export interface DeployCompleteEvent {
  sessionId: string;
  url: string | null;
  timestamp: string;
}

// Server → client events for the build namespace
export interface BuildServerEvents {
  build_start: (event: BuildStartEvent) => void;
  phase_start: (event: PhaseStartEvent) => void;
  agent_start: (event: AgentStartEvent) => void;
  agent_progress: (event: AgentProgressEvent) => void;
  agent_complete: (event: AgentCompleteEvent) => void;
  agent_error: (event: AgentErrorEvent) => void;
  credit_burn: (event: CreditBurnEvent) => void;
  file_update: (event: FileUpdateEvent) => void;
  progress: (event: ProgressEvent) => void;
  phase_complete: (event: PhaseCompleteEvent) => void;
  build_failed: (event: BuildFailedEvent) => void;
  plan_phase_start: (event: PlanPhaseStartEvent) => void;
  verify_result: (event: VerifyResultEvent) => void;
  fix_required: (event: FixRequiredEvent) => void;
  deploy_start: (event: DeployStartEvent) => void;
  deploy_complete: (event: DeployCompleteEvent) => void;
}

// Client → server events for the build namespace
export interface BuildClientEvents {
  join: (payload: string | { sessionId: string }) => void;
  join_session: (sessionId: string, ack: (joined: boolean) => void) => void;
  leave_session: (sessionId: string) => void;
}

// ── Project namespace events ──────────────────────────────────────────────────

export interface MemberJoinedEvent {
  projectId: string;
  userId: string;
  email: string;
  role: string;
  timestamp: string;
}

export interface SettingsChangedEvent {
  projectId: string;
  changedBy: string;
  fields: string[];
  timestamp: string;
}

export interface IntegrationConnectedEvent {
  projectId: string;
  integration: string;
  connectedBy: string;
  timestamp: string;
}

// Server → client events for the project namespace
export interface ProjectServerEvents {
  member_joined: (event: MemberJoinedEvent) => void;
  settings_changed: (event: SettingsChangedEvent) => void;
  integration_connected: (event: IntegrationConnectedEvent) => void;
}

// Client → server events for the project namespace
export interface ProjectClientEvents {
  join_project: (projectId: string, ack: (joined: boolean) => void) => void;
  leave_project: (projectId: string) => void;
}

// ── User namespace events ─────────────────────────────────────────────────────

export interface NotificationEvent {
  id: string;
  userId: string;
  title: string;
  message: string;
  level: "info" | "warning" | "error";
  timestamp: string;
}

export interface CreditLowEvent {
  userId: string;
  remaining: number;
  limit: number;
  percentUsed: number;
  timestamp: string;
}

export interface BuildCompleteEvent {
  userId: string;
  sessionId: string;
  projectId: string;
  projectName: string;
  durationMs: number;
  creditsUsed: number;
  timestamp: string;
}

// Server → client events for the user namespace
export interface UserServerEvents {
  notification: (event: NotificationEvent) => void;
  credit_low: (event: CreditLowEvent) => void;
  build_complete: (event: BuildCompleteEvent) => void;
}

// Client → server events for the user namespace
export interface UserClientEvents {
  subscribe: (ack: (ok: boolean) => void) => void;
}

// ── Shared socket data (stored on each socket after auth) ─────────────────────

export interface SocketData {
  userId: string;
  email?: string | undefined;
}

// ── Interview namespace events ─────────────────────────────────────────────────

import type { InterviewQuestion, SecurityContract, TaskItem } from "../server/types/interview.js";

export interface InterviewQuestionEvent {
  sessionId: string;
  question: InterviewQuestion;
  progress: string;
  timestamp: string;
}

export interface InterviewContractEvent {
  sessionId: string;
  contract: SecurityContract;
  tasks: TaskItem[];
  totalEstimatedMinutes: number;
  timestamp: string;
}

export interface InterviewApprovedEvent {
  sessionId: string;
  buildSessionId: string;
  tasks: TaskItem[];
  totalEstimatedMinutes: number;
  timestamp: string;
}

// Server → client events for the interview namespace
export interface InterviewServerEvents {
  "interview:question": (event: InterviewQuestionEvent) => void;
  "interview:contract": (event: InterviewContractEvent) => void;
  "interview:approved": (event: InterviewApprovedEvent) => void;
}

// Client → server events for the interview namespace
export interface InterviewClientEvents {
  join_session: (sessionId: string, ack: (joined: boolean) => void) => void;
  leave_session: (sessionId: string) => void;
}
