import { Server, type Namespace } from "socket.io";
import { type ServerType } from "@hono/node-server";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { type StreamBroadcaster } from "../agents/stream-handler.js";
import { type StreamChunk } from "../agents/model-gateway.js";
import { type Phase } from "../orchestrator/state-machine.js";
import { type AgentTaskType } from "../agents/model-gateway.js";
import { wsAuthMiddleware } from "./middleware/auth.js";
import { wsRateLimitMiddleware } from "./middleware/rate-limit.js";
import { registerBuildHandlers } from "./handlers/build-handler.js";
import { registerProjectHandlers } from "./handlers/project-handler.js";
import { registerUserHandlers } from "./handlers/user-handler.js";
import {
  emitAgentProgress,
  emitAgentStart,
  emitAgentComplete,
  emitAgentError,
  emitFileUpdate,
  emitProgress,
  emitPhaseComplete,
  emitBuildFailed,
} from "./handlers/build-handler.js";
import { emitNotification, emitCreditLow, emitBuildComplete } from "./handlers/user-handler.js";
import { emitMemberJoined, emitSettingsChanged, emitIntegrationConnected } from "./handlers/project-handler.js";
import {
  type SocketData,
  type BuildServerEvents,
  type BuildClientEvents,
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
  type MemberJoinedEvent,
  type SettingsChangedEvent,
  type IntegrationConnectedEvent,
  type NotificationEvent,
  type CreditLowEvent,
  type BuildCompleteEvent,
} from "./types.js";

// ── Namespace type aliases ────────────────────────────────────────────────────

type BuildNsp = Namespace<BuildClientEvents, BuildServerEvents, object, SocketData>;
type ProjectNsp = Namespace<ProjectClientEvents, ProjectServerEvents, object, SocketData>;
type UserNsp = Namespace<UserClientEvents, UserServerEvents, object, SocketData>;

// ── WebSocketServer ───────────────────────────────────────────────────────────

export class WebSocketServer {
  private readonly io: Server;
  private readonly buildNsp: BuildNsp;
  private readonly projectNsp: ProjectNsp;
  private readonly userNsp: UserNsp;

  constructor(httpServer: ServerType) {
    this.io = new Server(httpServer, {
      cors: {
        origin: config.FRONTEND_ORIGIN,
        credentials: true,
      },
      // Ping every 25s, disconnect if no pong within 20s
      pingInterval: 25_000,
      pingTimeout: 20_000,
      // Allow 1MB payloads (for file content chunks)
      maxHttpBufferSize: 1e6,
    });

    // ── Namespaces ────────────────────────────────────────────────────────────
    this.buildNsp = this.io.of("/build") as BuildNsp;
    this.projectNsp = this.io.of("/project") as ProjectNsp;
    this.userNsp = this.io.of("/user") as UserNsp;

    // ── Auth + rate-limit middleware per namespace ─────────────────────────────
    // Socket.io middleware types use `any` internally; cast is unavoidable
    for (const nsp of [this.buildNsp, this.projectNsp, this.userNsp]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nsp.use(wsAuthMiddleware as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nsp.use(wsRateLimitMiddleware as any);
    }

    registerBuildHandlers(this.buildNsp);
    registerProjectHandlers(this.projectNsp);
    registerUserHandlers(this.userNsp);

    logger.info("WebSocket server initialised (namespaces: /build /project /user)");
  }

  // ── StreamBroadcaster implementation ────────────────────────────────────────

  /**
   * Returns a StreamBroadcaster that can be passed into AgentDispatcher so
   * each SSE chunk is forwarded to all sockets watching the session.
   */
  makeStreamBroadcaster(): StreamBroadcaster {
    const nsp = this.buildNsp;
    return {
      broadcast(sessionId: string, taskId: string, chunk: StreamChunk): void {
        // We don't know agentType here, so we omit it from the progress payload
        emitAgentProgress(nsp, sessionId, {
          taskId,
          sessionId,
          agentType: "backend", // placeholder — callers should use emitAgentStart first
          chunk,
          tokensUsed: 0,
          timestamp: new Date().toISOString(),
        });
      },
    };
  }

  // ── Build events ─────────────────────────────────────────────────────────────

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

// ── Convenience re-exports for orchestrator integration ──────────────────────

export type { Phase };
export type { AgentTaskType };
