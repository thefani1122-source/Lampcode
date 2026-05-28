import { Server, type Namespace } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { type ServerType } from "@hono/node-server";
import { config, ALLOWED_ORIGINS } from "../server/config.js";
import { logger } from "../server/logger.js";
import { createRedis } from "../lib/redis.js";
import { type StreamChunk } from "../agents/model-gateway.js";

interface StreamBroadcaster {
  broadcast(sessionId: string, taskId: string, chunk: StreamChunk): void | Promise<void>;
}
import { type AgentTaskType } from "../agents/model-gateway.js";
import { wsAuthMiddleware } from "./middleware/auth.js";
import { wsRateLimitMiddleware } from "./middleware/rate-limit.js";
import { registerBuildHandlers } from "./handlers/build-handler.js";
import { registerProjectHandlers } from "./handlers/project-handler.js";
import { registerUserHandlers } from "./handlers/user-handler.js";
import {
  registerInterviewHandlers,
  emitInterviewQuestion,
  emitInterviewContract,
  emitInterviewApproved,
} from "./handlers/interview-handler.js";
import {
  emitBuildStart,
  emitPhaseStart,
  emitCreditBurn,
  emitAgentProgress,
  emitAgentStart,
  emitAgentComplete,
  emitAgentError,
  emitFileUpdate,
  emitProgress,
  emitPhaseComplete,
  emitBuildFailed,
  emitPlanPhaseStart,
  emitVerifyResult,
  emitFixRequired,
  emitDeployStart,
  emitDeployComplete,
} from "./handlers/build-handler.js";
import { emitNotification, emitCreditLow, emitBuildComplete } from "./handlers/user-handler.js";
import { emitMemberJoined, emitSettingsChanged, emitIntegrationConnected } from "./handlers/project-handler.js";
import {
  type SocketData,
  type BuildServerEvents,
  type BuildClientEvents,
  type BuildStartEvent,
  type PhaseStartEvent,
  type CreditBurnEvent,
  type ProjectServerEvents,
  type ProjectClientEvents,
  type UserServerEvents,
  type UserClientEvents,
  type AgentStartEvent,
  type AgentCompleteEvent,
  type AgentErrorEvent,
  type ProgressEvent,
  type PhaseCompleteEvent,
  type BuildFailedEvent,
  type FileUpdateEvent,
  type PlanPhaseStartEvent,
  type VerifyResultEvent,
  type FixRequiredEvent,
  type DeployStartEvent,
  type DeployCompleteEvent,
  type MemberJoinedEvent,
  type SettingsChangedEvent,
  type IntegrationConnectedEvent,
  type NotificationEvent,
  type CreditLowEvent,
  type BuildCompleteEvent,
  type InterviewServerEvents,
  type InterviewClientEvents,
  type InterviewQuestionEvent,
  type InterviewContractEvent,
  type InterviewApprovedEvent,
} from "./types.js";

// ── Namespace type aliases ────────────────────────────────────────────────────

type BuildNsp = Namespace<BuildClientEvents, BuildServerEvents, object, Partial<SocketData>>;
type ProjectNsp = Namespace<ProjectClientEvents, ProjectServerEvents, object, SocketData>;
type UserNsp = Namespace<UserClientEvents, UserServerEvents, object, SocketData>;
type InterviewNsp = Namespace<InterviewClientEvents, InterviewServerEvents, object, SocketData>;

// ── WebSocketServer ───────────────────────────────────────────────────────────

export class WebSocketServer {
  private readonly io: Server;
  private readonly buildNsp: BuildNsp;
  private readonly projectNsp: ProjectNsp;
  private readonly userNsp: UserNsp;
  private readonly interviewNsp: InterviewNsp;

  constructor(httpServer: ServerType) {
    this.io = new Server(httpServer, {
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
      },
      // Ping every 25s, disconnect if no pong within 20s
      pingInterval: 25_000,
      pingTimeout: 20_000,
      // Allow 1MB payloads (for file content chunks)
      maxHttpBufferSize: 1e6,
    });

    // ── Redis adapter — required for multi-instance deployments ──────────────
    // Each call creates a dedicated connection; ioredis handles reconnection.
    try {
      const pubClient = createRedis();
      const subClient = createRedis();
      this.io.adapter(createAdapter(pubClient, subClient));
      logger.info("Socket.IO Redis adapter attached");
    } catch (err) {
      logger.warn({ err }, "Socket.IO Redis adapter failed to attach — falling back to in-memory adapter");
    }

    // ── Namespaces ────────────────────────────────────────────────────────────
    // Build uses root namespace (/) so frontend can connect without a path prefix.
    this.buildNsp = this.io.of("/") as BuildNsp;
    this.projectNsp = this.io.of("/project") as ProjectNsp;
    this.userNsp = this.io.of("/user") as UserNsp;
    this.interviewNsp = this.io.of("/interview") as InterviewNsp;

    // ── Auth + rate-limit middleware per namespace ─────────────────────────────
    // Root (/) is auth-optional: only sessionId query param needed to stream progress.
    // All other namespaces require a valid JWT.
    // Socket.io middleware types use `any` internally; cast is unavoidable
    for (const nsp of [this.projectNsp, this.userNsp, this.interviewNsp]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nsp.use(wsAuthMiddleware as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nsp.use(wsRateLimitMiddleware as any);
    }
    // Root (/): no auth or rate-limit — clients join session rooms via sessionId query param

    registerBuildHandlers(this.buildNsp);
    registerProjectHandlers(this.projectNsp);
    registerUserHandlers(this.userNsp);
    registerInterviewHandlers(this.interviewNsp);

    logger.info("WebSocket server initialised (namespaces: / /project /user /interview)");
  }

  // ── Direct session emit ───────────────────────────────────────────────────────

  emitToSession(sessionId: string, event: string, data: Record<string, unknown>): void {
    this.io.to(`session:${sessionId}`).emit(event, data);
  }

  // Emit to a literal room name — used for bare sessionId rooms joined via 'join' event
  emitToRoom(room: string, event: string, data: Record<string, unknown>): void {
    this.io.to(room).emit(event, data);
  }

  emitToUser(userId: string, event: string, data: Record<string, unknown>): void {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  emitToProject(projectId: string, event: string, data: Record<string, unknown>): void {
    this.io.to(`project:${projectId}`).emit(event, data);
  }

  // ── StreamBroadcaster implementation ────────────────────────────────────────

  /**
   * Returns a StreamBroadcaster that can be passed into AgentDispatcher so
   * each SSE chunk is forwarded to all sockets watching the session.
   */
  makeStreamBroadcaster(agentType: AgentTaskType = "backend"): StreamBroadcaster {
    const nsp = this.buildNsp;
    const resolvedAgentType = agentType;
    return {
      broadcast(sessionId: string, taskId: string, chunk: StreamChunk): void {
        emitAgentProgress(nsp, sessionId, {
          taskId,
          sessionId,
          agentType: resolvedAgentType,
          chunk,
          tokensUsed: 0,
          timestamp: new Date().toISOString(),
        });
      },
    };
  }

  // ── Build events ─────────────────────────────────────────────────────────────

  buildStart(sessionId: string, event: BuildStartEvent): void {
    emitBuildStart(this.buildNsp, sessionId, event);
  }

  phaseStart(sessionId: string, event: PhaseStartEvent): void {
    emitPhaseStart(this.buildNsp, sessionId, event);
  }

  creditBurn(sessionId: string, event: CreditBurnEvent): void {
    emitCreditBurn(this.buildNsp, sessionId, event);
  }

  agentStart(sessionId: string, event: AgentStartEvent): void {
    emitAgentStart(this.buildNsp, sessionId, event);
  }

  agentProgress(sessionId: string, taskId: string, agentType: AgentTaskType, chunk: StreamChunk, tokensUsed: number): void {
    emitAgentProgress(this.buildNsp, sessionId, {
      taskId,
      sessionId,
      agentType,
      chunk,
      tokensUsed,
      timestamp: new Date().toISOString(),
    });
  }

  agentComplete(sessionId: string, event: AgentCompleteEvent): void {
    emitAgentComplete(this.buildNsp, sessionId, event);
  }

  agentError(sessionId: string, event: AgentErrorEvent): void {
    emitAgentError(this.buildNsp, sessionId, event);
  }

  fileUpdate(sessionId: string, event: FileUpdateEvent): void {
    emitFileUpdate(this.buildNsp, sessionId, event);
  }

  progress(sessionId: string, event: ProgressEvent): void {
    emitProgress(this.buildNsp, sessionId, event);
  }

  phaseComplete(sessionId: string, event: PhaseCompleteEvent): void {
    emitPhaseComplete(this.buildNsp, sessionId, event);
  }

  buildFailed(sessionId: string, event: BuildFailedEvent): void {
    emitBuildFailed(this.buildNsp, sessionId, event);
  }

  planPhaseStart(sessionId: string, event: PlanPhaseStartEvent): void {
    emitPlanPhaseStart(this.buildNsp, sessionId, event);
  }

  verifyResult(sessionId: string, event: VerifyResultEvent): void {
    emitVerifyResult(this.buildNsp, sessionId, event);
  }

  fixRequired(sessionId: string, event: FixRequiredEvent): void {
    emitFixRequired(this.buildNsp, sessionId, event);
  }

  deployStart(sessionId: string, event: DeployStartEvent): void {
    emitDeployStart(this.buildNsp, sessionId, event);
  }

  deployComplete(sessionId: string, event: DeployCompleteEvent): void {
    emitDeployComplete(this.buildNsp, sessionId, event);
  }

  // ── Project events ────────────────────────────────────────────────────────

  memberJoined(projectId: string, event: MemberJoinedEvent): void {
    emitMemberJoined(this.projectNsp, projectId, event);
  }

  settingsChanged(projectId: string, event: SettingsChangedEvent): void {
    emitSettingsChanged(this.projectNsp, projectId, event);
  }

  integrationConnected(projectId: string, event: IntegrationConnectedEvent): void {
    emitIntegrationConnected(this.projectNsp, projectId, event);
  }

  // ── User events ───────────────────────────────────────────────────────────

  notify(userId: string, event: NotificationEvent): void {
    emitNotification(this.userNsp, userId, event);
  }

  creditLow(userId: string, event: CreditLowEvent): void {
    emitCreditLow(this.userNsp, userId, event);
  }

  notifyBuildComplete(userId: string, event: BuildCompleteEvent): void {
    emitBuildComplete(this.userNsp, userId, event);
  }

  // ── Interview events ──────────────────────────────────────────────────────

  emitInterviewQuestion(sessionId: string, event: InterviewQuestionEvent): void {
    emitInterviewQuestion(this.interviewNsp, sessionId, event);
  }

  emitInterviewContract(sessionId: string, event: InterviewContractEvent): void {
    emitInterviewContract(this.interviewNsp, sessionId, event);
  }

  emitInterviewApproved(sessionId: string, event: InterviewApprovedEvent): void {
    emitInterviewApproved(this.interviewNsp, sessionId, event);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Gracefully close all connections. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.io.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info("WebSocket server closed");
  }

  /** Number of connected sockets across all namespaces. */
  async connectedCount(): Promise<number> {
    const sockets = await this.io.fetchSockets();
    return sockets.length;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _wsServer: WebSocketServer | null = null;

export function createWebSocketServer(httpServer: ServerType): WebSocketServer {
  if (_wsServer !== null) {
    logger.warn("WebSocketServer already initialised — returning existing instance");
    return _wsServer;
  }
  _wsServer = new WebSocketServer(httpServer);
  return _wsServer;
}

export function getWebSocketServer(): WebSocketServer {
  if (_wsServer === null) {
    throw new Error("WebSocketServer not yet initialised — call createWebSocketServer first");
  }
  return _wsServer;
}

export type { AgentTaskType };
