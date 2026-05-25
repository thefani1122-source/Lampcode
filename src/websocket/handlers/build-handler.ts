import { type Namespace, type Socket } from "socket.io";
import { logger } from "../../server/logger.js";
import {
  type BuildServerEvents,
  type BuildClientEvents,
  type BuildStartEvent,
  type PhaseStartEvent,
  type CreditBurnEvent,
  type SocketData,
} from "../types.js";

type BuildNamespace = Namespace<BuildClientEvents, BuildServerEvents, object, SocketData>;
type BuildSocket = Socket<BuildClientEvents, BuildServerEvents, object, SocketData>;

const SESSION_ROOM = (sessionId: string) => `session:${sessionId}`;

export function registerBuildHandlers(nsp: BuildNamespace): void {
  nsp.on("connection", (socket: BuildSocket) => {
    const userId = socket.data.userId;
    logger.info({ socketId: socket.id, userId }, "Build WS connected");

    // Auto-join session room if sessionId provided in handshake query
    const querySid = socket.handshake.query["sessionId"];
    if (typeof querySid === "string" && querySid.length > 0) {
      void socket.join(SESSION_ROOM(querySid));
      console.log(`[WS JOIN] auto-join sessionId=${querySid} socketId=${socket.id} userId=${userId}`);
      logger.info({ socketId: socket.id, sessionId: querySid }, "Auto-joined build session room from query");
    }

    // Client joins a session room to receive updates for that build
    socket.on("join_session", (sessionId, ack) => {
      void socket.join(SESSION_ROOM(sessionId));
      console.log(`[WS JOIN] join_session sessionId=${sessionId} socketId=${socket.id} userId=${userId}`);
      logger.debug({ socketId: socket.id, sessionId }, "Joined build session room");
      ack(true);
    });

    socket.on("leave_session", (sessionId) => {
      void socket.leave(SESSION_ROOM(sessionId));
      logger.debug({ socketId: socket.id, sessionId }, "Left build session room");
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "Build WS disconnected");
    });
  });
}

// ── Emitter helpers called from other modules ─────────────────────────────────

export function emitBuildStart(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildStartEvent,
): void {
  const room = SESSION_ROOM(sessionId);
  const size = nsp.adapter.rooms.get(room)?.size ?? 0;
  console.log(`[WS EMIT] build_start room=${room} clients=${size}`);
  nsp.to(room).emit("build_start", data);
}

export function emitPhaseStart(
  nsp: BuildNamespace,
  sessionId: string,
  data: PhaseStartEvent,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("phase_start", data);
}

export function emitCreditBurn(
  nsp: BuildNamespace,
  sessionId: string,
  data: CreditBurnEvent,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("credit_burn", data);
}

/**
 * Broadcast an agent_start event to all sockets in a session room.
 * Exported so the dispatcher / orchestrator can call it without
 * holding a direct reference to the Socket.io instance.
 */
export function emitAgentStart(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["agent_start"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("agent_start", data);
}

export function emitAgentProgress(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["agent_progress"] extends (e: infer E) => void ? E : never,
): void {
  const room = SESSION_ROOM(sessionId);
  const size = nsp.adapter.rooms.get(room)?.size ?? 0;
  if (size === 0) {
    console.log(`[WS EMIT] agent_progress room=${room} clients=0 — no subscribers!`);
  }
  nsp.to(room).emit("agent_progress", data);
}

export function emitAgentComplete(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["agent_complete"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("agent_complete", data);
}

export function emitAgentError(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["agent_error"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("agent_error", data);
}

export function emitFileUpdate(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["file_update"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("file_update", data);
}

export function emitProgress(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["progress"] extends (e: infer E) => void ? E : never,
): void {
  const room = SESSION_ROOM(sessionId);
  const size = nsp.adapter.rooms.get(room)?.size ?? 0;
  console.log(`[WS EMIT] progress room=${room} clients=${size} msg="${data.message}"`);
  nsp.to(room).emit("progress", data);
}

export function emitPhaseComplete(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["phase_complete"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("phase_complete", data);
}

export function emitBuildFailed(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["build_failed"] extends (e: infer E) => void ? E : never,
): void {
  const room = SESSION_ROOM(sessionId);
  const size = nsp.adapter.rooms.get(room)?.size ?? 0;
  console.log(`[WS EMIT] build_failed room=${room} clients=${size} reason="${data.reason}"`);
  nsp.to(room).emit("build_failed", data);
}

export function emitPlanPhaseStart(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["plan_phase_start"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("plan_phase_start", data);
}

export function emitVerifyResult(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["verify_result"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("verify_result", data);
}

export function emitFixRequired(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["fix_required"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("fix_required", data);
}

export function emitDeployStart(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["deploy_start"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("deploy_start", data);
}

export function emitDeployComplete(
  nsp: BuildNamespace,
  sessionId: string,
  data: BuildServerEvents["deploy_complete"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("deploy_complete", data);
}
