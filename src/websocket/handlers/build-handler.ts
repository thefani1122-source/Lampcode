import { type Namespace, type Socket } from "socket.io";
import { eq } from "drizzle-orm";
import { logger } from "../../server/logger.js";
import { createRedis } from "../../lib/redis.js";
import { db } from "../../db/client.js";
import { buildSessions } from "../../db/schema.js";
import { pauseSandbox, ensurePreviewForProject, restorePreviewForProject } from "../../preview/e2b-service.js";
import { downloadProjectFiles } from "../../storage/project-files.js";
import { loadMessages } from "../message-recorder.js";

const redis = createRedis();
import {
  type BuildServerEvents,
  type BuildClientEvents,
  type BuildStartEvent,
  type PhaseStartEvent,
  type CreditBurnEvent,
  type SocketData,
} from "../types.js";
import { resolveApproval, sweepBySession } from "../../agents/pending-approvals.js";
import { resolveAnswer, sweepAnswersBySession } from "../../agents/pending-answers.js";

type BuildNamespace = Namespace<BuildClientEvents, BuildServerEvents, object, SocketData>;
type BuildSocket = Socket<BuildClientEvents, BuildServerEvents, object, SocketData>;

const SESSION_ROOM = (sessionId: string) => sessionId;

// ── Pause E2B preview sandbox on disconnect ───────────────────────────────────
// Sandboxes are billed while running. If everyone navigates away from a build
// session, pause its sandbox after a grace period so a quick reconnect
// (refresh, flaky connection) doesn't pay the cold-start cost again.
//
// The grace must be generous: the build WS often closes right after a build
// completes while the user is still LOOKING at the preview. A short grace
// paused the sandbox out from under them ("Sandbox Not Found" in the iframe).
// Default 15 min gives a real testing window; tune via SANDBOX_GRACE_MS.
const PAUSE_GRACE_MS = Number(process.env["SANDBOX_GRACE_MS"] ?? 15 * 60 * 1000);
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

// Both call sites await this inside a connection/join handler, so it must
// never reject: an unhandled rejection there takes the process down, and a
// throw before ack(true) leaves the client's join unacknowledged forever.
// Replay is a convenience — a client that misses it still receives every
// subsequent live event — so a Redis failure degrades to "no replay".
async function replayBuffer(socket: BuildSocket, sessionId: string): Promise<number> {
  let buffered: string[];
  try {
    buffered = await redis.lrange(`buffer:${sessionId}`, 0, -1);
  } catch (err) {
    logger.warn({ socketId: socket.id, sessionId, err }, "Could not replay buffered build events");
    return 0;
  }
  if (buffered.length > 0) {
    // Tell the client to drop whatever it has before the replay lands. A tab
    // that refreshes MID-BUILD restores its own sessionStorage snapshot and
    // then receives this buffer on top of it, which showed the agent's
    // thinking and replies twice — reported on 2026-10-04. build:history
    // already does exactly this for a FINISHED session; the mid-build path
    // simply never had an equivalent.
    // Same escape hatch settleFinishedSession uses for build:history — these
    // client-facing names are not in the typed server-event map.
    (socket.emit.bind(socket) as (event: string, data: unknown) => boolean)(
      "build:replay_start",
      { sessionId, count: buffered.length },
    );
    for (const raw of buffered) {
      try {
        const event = JSON.parse(raw);
        socket.emit(event.type, event.payload);
      } catch {}
    }
    logger.debug({ socketId: socket.id, sessionId, count: buffered.length }, "Replayed buffered events");
  }
  return buffered.length;
}

/**
 * Settle the UI for a build that finished before this socket existed.
 *
 * The event buffer lives in Redis for one hour. After that, reopening a
 * finished project replayed nothing, so the client never received
 * build:complete and sat on skeleton placeholders reading "Building..."
 * forever — for a build that had succeeded hours earlier. The session row
 * knew the truth the whole time and nobody asked it.
 *
 * Only called when the replay was empty, so a live or recently-finished build
 * is untouched. The files come from storage rather than the buffer, which is
 * why this can restore the view at all.
 */
async function settleFinishedSession(socket: BuildSocket, sessionId: string): Promise<void> {
  let row: { status: string; error: string | null; projectId: string } | undefined;
  try {
    const rows = await db
      .select({ status: buildSessions.status, error: buildSessions.error, projectId: buildSessions.projectId })
      .from(buildSessions)
      .where(eq(buildSessions.id, sessionId))
      .limit(1);
    row = rows[0] as typeof row;
  } catch (err) {
    logger.warn({ sessionId, err }, "Could not read session state to settle a replayed view");
    return;
  }
  if (!row) return;

  // session_status is: running, paused, completed, failed, cancelled, success.
  // "running" and "paused" are left alone — a build still in flight sends its
  // own events, and guessing would contradict them.
  const failed = row.status === "failed" || row.status === "cancelled";
  const finished = row.status === "success" || row.status === "completed";
  if (!failed && !finished) return;

  const emitRaw = socket.emit.bind(socket) as (event: string, data: unknown) => boolean;

  // The stored conversation, rendered back through the same events that drew
  // it the first time. The rows are semantic messages, so nothing here can
  // replay something that has since stopped being true — notably a preview
  // URL, which is resolved from the live sandbox instead.
  let history: Awaited<ReturnType<typeof loadMessages>> = [];
  try {
    history = await loadMessages(sessionId);
  } catch (err) {
    logger.warn({ sessionId, err }, "Could not load stored messages for a replayed view");
  }

  // Tells the client these are stored messages, not live ones, so it replaces
  // whatever it restored from its own sessionStorage snapshot instead of
  // appending to it. Without this, a tab left open past the Redis buffer's
  // hour and then refreshed would show the whole conversation twice.
  emitRaw("build:history", { sessionId, count: history.length });

  let summary = "";
  let hint: string | undefined;
  for (const m of history) {
    switch (m.role) {
      case "user":
        emitRaw("build:prompt", { sessionId, text: m.content });
        break;
      case "thinking":
        emitRaw("build:thinking", { sessionId, text: m.content });
        break;
      case "tool":
        // Two events: one opens the line, the other marks it finished, which
        // is how the chat draws a completed tool call.
        emitRaw("build:tool_call", { sessionId, tool: m.content });
        emitRaw("build:tool_result", { sessionId, tool: m.content });
        break;
      case "assistant":
        // Held back: it belongs to build:complete, which must come last
        // because the client stops accepting chat events once it arrives.
        summary = m.content;
        hint = typeof m.metadata["hint"] === "string" ? (m.metadata["hint"] as string) : undefined;
        break;
      case "error":
        emitRaw("build:error", { sessionId, message: m.content });
        break;
    }
  }

  if (failed) {
    emitRaw("build:failed", {
      sessionId,
      error:
        row.error ??
        (row.status === "cancelled" ? "This build was cancelled." : "This build failed. Run it again to try once more."),
    });
    logger.info({ sessionId, status: row.status, messages: history.length }, "Replayed a finished session");
    return;
  }

  let files: Record<string, string> = {};
  try {
    files = await downloadProjectFiles(row.projectId);
  } catch (err) {
    logger.warn({ sessionId, err }, "Could not load stored files while settling a replayed view");
  }

  emitRaw("build:complete", {
    sessionId,
    files,
    totalFiles: Object.keys(files).length,
    // Only invented when the session predates stored history; otherwise the
    // model's own words are what the person reads back.
    summary:
      summary ||
      "This build finished before its conversation was being saved, so the log for it is gone. " +
        "The project and its files are here, and you can carry on from where you left off.",
    hint,
  });
  logger.info(
    { sessionId, messages: history.length, files: Object.keys(files).length },
    "Replayed a finished session",
  );
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
      if (!projectId) return;
      cancelPendingPause(projectId);

      // Opening or reconnecting to a project brings its preview back: resume
      // the paused snapshot if there is one, and otherwise rebuild from the
      // stored files. Either way the client gets a FRESH url, because a
      // revisit on a stale one shows "Sandbox Not Found".
      // The colon-namespaced preview events live outside the typed build event
      // map, so emit them through a loose-typed handle.
      const emitRaw = socket.emit.bind(socket) as (event: string, data: unknown) => boolean;
      void ensurePreviewForProject(projectId, (line) =>
        emitRaw("build:preview_log", { sessionId, line }),
      )
        .then(async (url) => {
          if (url) {
            emitRaw("build:preview_url", { sessionId, url });
            return;
          }
          // E2B reclaims a sandbox after a while, so this is the ordinary case
          // for anyone who closes the tab and comes back — not an error. Bring
          // it back without being asked: a project you open should be running,
          // which is what people already expect from this kind of product.
          // Costs a fresh sandbox per reopened project, deliberately.
          logger.info({ projectId, sessionId }, "resume-on-open: nothing to resume — rebuilding");
          emitRaw("build:preview_loading", { sessionId });
          try {
            const restored = await restorePreviewForProject(projectId, sessionId, (line) =>
              emitRaw("build:preview_log", { sessionId, line }),
            );
            if (restored) emitRaw("build:preview_url", { sessionId, url: restored });
            else {
              emitRaw("build:preview_failed", {
                sessionId,
                message: "This project has no saved files to restore a preview from.",
              });
            }
          } catch (err) {
            logger.warn({ projectId, sessionId, err }, "resume-on-open: rebuild failed");
            emitRaw("build:preview_failed", {
              sessionId,
              message: err instanceof Error ? err.message : "The preview could not be restored.",
            });
          }
        })
        .catch((err) => {
          logger.warn({ projectId, sessionId, err }, "resume-on-open failed");
          emitRaw("build:preview_failed", {
            sessionId,
            message: "The preview could not be started. Send a message to rebuild the project.",
          });
        });
    };

    // Auto-join session room if sessionId provided in handshake query (Step 1)
    const querySid = socket.handshake.query["sessionId"];
    if (typeof querySid === "string" && querySid.length > 0) {
      const owned = await verifySessionOwner(querySid, userId);
      if (!owned) {
        logger.warn({ socketId: socket.id, userId, sessionId: querySid }, "Build WS forbidden — user does not own session");
        (socket.emit as (e: string, d: unknown) => boolean)("error", { code: 403, message: "Forbidden" });
        socket.disconnect(true);
        return;
      }
      const room = SESSION_ROOM(querySid);
      socket.join(room); // synchronous in Socket.IO v4
      const size = nsp.adapter.rooms.get(room)?.size ?? 0;
      console.log(`[WS JOIN] auto-join room=${room} socketId=${socket.id} userId=${userId} totalClients=${size}`);
      logger.info({ socketId: socket.id, sessionId: querySid, totalClients: size }, "Auto-joined build session room from query");
      if ((await replayBuffer(socket, querySid)) === 0) await settleFinishedSession(socket, querySid);
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
          (socket.emit as (e: string, d: unknown) => boolean)("error", { code: 403, message: "Forbidden" });
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
        (socket.emit as (e: string, d: unknown) => boolean)("error", { code: 403, message: "Forbidden" });
        socket.disconnect(true);
        ack(false);
        return;
      }
      const room = SESSION_ROOM(sessionId);
      socket.join(room); // synchronous in Socket.IO v4
      const size = nsp.adapter.rooms.get(room)?.size ?? 0;
      console.log(`[WS JOIN] join_session room=${room} socketId=${socket.id} userId=${userId} totalClients=${size}`);
      logger.debug({ socketId: socket.id, sessionId, totalClients: size }, "Joined build session room");
      if ((await replayBuffer(socket, sessionId)) === 0) await settleFinishedSession(socket, sessionId);
      await trackSession(sessionId);
      ack(true);
    });

    socket.on("leave_session", (sessionId) => {
      void socket.leave(SESSION_ROOM(sessionId));
      logger.debug({ socketId: socket.id, sessionId }, "Left build session room");
    });

    // User approves or denies a pending write-MCP tool call.
    // Ownership proof: the socket must be in the session's room — sockets only
    // join a room after verifySessionOwner() passes during the join/join_session
    // flow. resolveApproval() also checks the stored sessionId against the
    // payload's sessionId as a second layer, so a forged toolCallId with a
    // mismatched session is silently rejected at both levels.
    socket.on("build:write_action_decision", (payload) => {
      const { toolCallId, sessionId: sid, approved } = payload;
      if (!socket.rooms.has(sid)) {
        logger.warn(
          { socketId: socket.id, userId, toolCallId, sid },
          "Write action decision rejected — socket not in session room",
        );
        return;
      }
      const resolved = resolveApproval(toolCallId, sid, approved);
      if (!resolved) {
        logger.warn(
          { socketId: socket.id, userId, toolCallId, sid },
          "Write action decision: unknown or already-expired toolCallId",
        );
      }
    });

    // The user's answer to an ask_user question. Same ownership proof as the
    // write decision above: the socket must be in the session's room, and
    // resolveAnswer re-checks the stored sessionId. An answer steers what gets
    // built, so it is not something a stray toolCallId should be able to set.
    socket.on("build:answer", (payload) => {
      const { toolCallId, sessionId: sid, answer } = payload;
      if (!socket.rooms.has(sid)) {
        logger.warn(
          { socketId: socket.id, userId, toolCallId, sid },
          "Answer rejected — socket not in session room",
        );
        return;
      }
      if (typeof answer !== "string" || answer.trim().length === 0) return;
      if (!resolveAnswer(toolCallId, sid, answer.trim())) {
        logger.warn(
          { socketId: socket.id, userId, toolCallId, sid },
          "Answer: unknown or already-expired toolCallId",
        );
      }
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "Build WS disconnected");

      const sessionId = activeSessionId;
      if (!sessionId) return;

      // Deny all pending write-action approvals for this session immediately —
      // the user is gone and can't respond; waiting would leave executeTool()
      // blocked until the 120 s timeout fires naturally.
      sweepBySession(sessionId);
      // Same reasoning for questions: the person is gone and cannot answer,
      // so release the build now instead of holding it for ten minutes.
      sweepAnswersBySession(sessionId);

      // Pause this project's preview sandbox after a grace period.
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
