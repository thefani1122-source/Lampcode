import { type Namespace, type Socket } from "socket.io";
import { eq } from "drizzle-orm";
import { logger } from "../../server/logger.js";
import { createRedis } from "../../lib/redis.js";
import { db } from "../../db/client.js";
import { buildSessions } from "../../db/schema.js";
import { pauseSandbox } from "../../preview/e2b-service.js";

const redis = createRedis();
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

const SESSION_ROOM = (sessionId: string) => sessionId;

// ── Pause E2B preview sandbox on disconnect ───────────────────────────────────
// Sandboxes are billed while running. If everyone navigates away from a build
// session, pause its sandbox after a short grace period so a quick reconnect
// (refresh, flaky connection) doesn't pay the cold-start cost again.
const PAUSE_GRACE_MS = 2 * 60 * 1000;
const pendingPauseTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function resolveProjectId(sessionId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ projectId: buildSessions.projectId })
      .from(buildSessions)
      .where(eq(buildSessions.id, sessionId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  } catch (err) {
    logger.warn({ sessionId, err }, "Failed to resolve projectId for sandbox pause");
    return null;
  }
}

async function verifySessionOwner(sessionId: string, userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ userId: buildSessions.userId })
      .from(buildSessions)
      .where(eq(buildSessions.id, sessionId))
      .limit(1);
    return rows[0]?.userId === userId;
  } catch (err) {
    logger.warn({ sessionId, userId, err }, "Failed to verify session ownership");
    return false;
  }
}

function cancelPendingPause(projectId: string): void {
  const timer = pendingPauseTimers.get(projectId);
  if (!timer) return;
  clearTimeout(timer);
  pendingPauseTimers.delete(projectId);
  logger.debug({ projectId }, "Cancelled pending sandbox pause — client reconnected");
}

function schedulePause(projectId: string, sessionId: string): void {
  cancelPendingPause(projectId);
  const timer = setTimeout(() => {
    pendingPauseTimers.delete(projectId);
    void pauseSandbox(projectId).catch((err) => {
      logger.warn({ projectId, sessionId, err }, "Failed to pause preview sandbox after disconnect");
    });
  }, PAUSE_GRACE_MS);
  pendingPauseTimers.set(projectId, timer);
}

async function replayBuffer(socket: BuildSocket, sessionId: string): Promise<void> {
  const buffered = await redis.lrange(`buffer:${sessionId}`, 0, -1);
  if (buffered.length > 0) {
    for (const raw of buffered) {
      try {
        const event = JSON.parse(raw);
        socket.emit(event.type, event.payload);
      } catch {}
    }
    logger.debug({ socketId: socket.id, sessionId, count: buffered.length }, "Replayed buffered events");
  }
}

export function registerBuildHandlers(nsp: BuildNamespace): void {
  nsp.on("connection", async (socket: BuildSocket) => {
    const userId = socket.data.userId; // always set — wsBuildAuthMiddleware required it
    console.log(`[WS CONNECT] socketId=${socket.id} userId=${userId} query=${JSON.stringify(socket.handshake.query)}`);
    logger.info({ socketId: socket.id, userId }, "Build WS connected");

    // Tracks the most recently joined session for this socket so that, on
    // disconnect, we can resolve its projectId and schedule a sandbox pause.
    let activeSessionId: string | undefined;

    const trackSession = async (sessionId: string): Promise<void> => {
      activeSessionId = sessionId;
      const projectId = await resolveProjectId(sessionId);
      if (projectId) cancelPendingPause(projectId);
    };

    // Auto-join session room if sessionId provided in handshake query (Step 1)
    const querySid = socket.handshake.query["sessionId"];
    if (typeof querySid === "string" && querySid.length > 0) {
      const owned = await verifySessionOwner(querySid, userId);
      if (!owned) {
        logger.warn({ socketId: socket.id, userId, sessionId: querySid }, "Build WS forbidden — user does not own session");
        socket.emit("error", { code: 403, message: "Forbidden" });
        socket.disconnect(true);
        return;
      }
      const room = SESSION_ROOM(querySid);
      socket.join(room); // synchronous in Socket.IO v4
      const size = nsp.adapter.rooms.get(room)?.size ?? 0;
      console.log(`[WS JOIN] auto-join room=${room} socketId=${socket.id} userId=${userId} totalClients=${size}`);
      logger.info({ socketId: socket.id, sessionId: querySid, totalClients: size }, "Auto-joined build session room from query");
      await replayBuffer(socket, querySid);
      await trackSession(querySid);
    } else {
      console.log(`[WS CONNECT] no sessionId in query — client must emit join_session manually`);
    }

    // Simple join event: room = bare sessionId (used by frontend workspace).
    // Accepts either a plain string or { sessionId } object from the client.
    socket.on("join", (payload: string | { sessionId: string }) => {
      const sid = typeof payload === "string" ? payload : payload.sessionId;
      if (!sid) return;
      void verifySessionOwner(sid, userId).then((owned) => {
        if (!owned) {
          logger.warn({ socketId: socket.id, userId, sessionId: sid }, "Build WS forbidden — user does not own session (join)");
          socket.emit("error", { code: 403, message: "Forbidden" });
          socket.disconnect(true);
          return;
        }
        socket.join(sid);
        logger.debug({ socketId: socket.id, sessionId: sid }, "Joined session room (join event)");
        void trackSession(sid);
      });
    });

    // Client joins a session room to receive updates for that build
    socket.on("join_session", async (sessionId, ack) => {
      const owned = await verifySessionOwner(sessionId, userId);
      if (!owned) {
        logger.warn({ socketId: socket.id, userId, sessionId }, "Build WS forbidden — user does not own session (join_session)");
        socket.emit("error", { code: 403, message: "Forbidden" });
        socket.disconnect(true);
        ack(false);
        return;
      }
      const room = SESSION_ROOM(sessionId);
      socket.join(room); // synchronous in Socket.IO v4
      const size = nsp.adapter.rooms.get(room)?.size ?? 0;
      console.log(`[WS JOIN] join_session room=${room} socketId=${socket.id} userId=${userId} totalClients=${size}`);
      logger.debug({ socketId: socket.id, sessionId, totalClients: size }, "Joined build session room");
      await replayBuffer(socket, sessionId);
      await trackSession(sessionId);
      ack(true);
    });

    socket.on("leave_session", (sessionId) => {
      void socket.leave(SESSION_ROOM(sessionId));
      logger.debug({ socketId: socket.id, sessionId }, "Left build session room");
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "Build WS disconnected");

      // Pause this project's preview sandbox after a grace period — gives a
      // quick reconnect (page refresh, brief network blip) time to cancel it
      // via trackSession() before we pay to spin the sandbox back up.
      const sessionId = activeSessionId;
      if (!sessionId) return;
      void resolveProjectId(sessionId).then((projectId) => {
        if (projectId) schedulePause(projectId, sessionId);
      });
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
