import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { buildMessages, buildSessions } from "../db/schema.js";
import { logger } from "../server/logger.js";

/**
 * Durable chat history for a build session.
 *
 * Until now the conversation lived in React state, a sessionStorage snapshot
 * and a Redis event buffer with a one-hour TTL. Closing the tab lost it, and
 * reopening a project showed an empty chat for work that had really happened.
 *
 * What is stored here is the MESSAGES a person would read back, not the socket
 * events that produced them. An event archive would weld the schema to today's
 * wire protocol, and replaying it would also replay things that stop being
 * true — a preview URL, for one, pointing at a sandbox that has long since
 * been reclaimed. The live preview is resolved from the sandbox on open and
 * never from here.
 *
 * Nothing in this module is allowed to disturb a build. Every write is
 * fire-and-forget and every failure is swallowed after a warning: losing a
 * line of history is a far smaller problem than failing the build that
 * produced it.
 */

type Role = "user" | "thinking" | "tool" | "assistant" | "error";

interface SessionState {
  projectId: string | null;
  /** Resolves once per session, so a chatty build does not re-query. */
  resolving: Promise<string | null> | null;
  seq: number;
  /** Model output arrives in chunks; it becomes one message when something
   *  else happens, exactly as the chat renders it. */
  openThinking: string | null;
  /** The checks card, held until build:complete so it rides on the same row
   *  the summary does. Emitted as its own event, but stored with the message
   *  it belongs to — a card that is only emitted is gone on the next reload,
   *  which is the same mistake the preview URL made. */
  checks: unknown;
}

const sessions = new Map<string, SessionState>();

// A build that never reaches a terminal event (process killed mid-flight)
// would otherwise keep its entry forever.
const MAX_TRACKED_SESSIONS = 500;

function stateFor(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    s = { projectId: null, resolving: null, seq: 0, openThinking: null, checks: null };
    sessions.set(sessionId, s);
  }
  return s;
}

async function projectIdFor(sessionId: string, state: SessionState): Promise<string | null> {
  if (state.projectId) return state.projectId;
  if (!state.resolving) {
    state.resolving = db
      .select({ projectId: buildSessions.projectId })
      .from(buildSessions)
      .where(eq(buildSessions.id, sessionId))
      .limit(1)
      .then((rows) => rows[0]?.projectId ?? null)
      .catch((err) => {
        logger.warn({ sessionId, err }, "[history] could not resolve projectId");
        return null;
      })
      .finally(() => {
        state.resolving = null;
      });
  }
  const id = await state.resolving;
  if (id) state.projectId = id;
  return id;
}

function write(
  sessionId: string,
  role: Role,
  content: string,
  metadata: Record<string, unknown> = {},
): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const state = stateFor(sessionId);
  const seq = state.seq++;

  void (async () => {
    const projectId = await projectIdFor(sessionId, state);
    // No project means no session row — the build was deleted, or this id was
    // never real. Either way there is nothing to attach history to.
    if (!projectId) return;
    await db.insert(buildMessages).values({
      id: randomUUID(),
      sessionId,
      projectId,
      seq,
      role,
      content: trimmed,
      metadata,
    });
  })().catch((err) => {
    logger.warn({ sessionId, role, err }, "[history] could not store a message");
  });
}

/** Close the streaming model output, if any, as a single message. */
function closeThinking(sessionId: string): void {
  const state = stateFor(sessionId);
  const text = state.openThinking;
  state.openThinking = null;
  if (text) write(sessionId, "thinking", text);
}

/** The prompt the person typed. Called when a build starts. */
export function recordUserPrompt(sessionId: string, prompt: string): void {
  write(sessionId, "user", prompt);
}

/**
 * Observe one outgoing build event and store whatever part of it belongs in
 * the history. Called from the socket server, so every emitter is covered
 * without each one having to remember.
 */
export function recordEvent(sessionId: string, event: string, data: Record<string, unknown>): void {
  try {
    const str = (k: string): string => (typeof data[k] === "string" ? (data[k] as string) : "");

    switch (event) {
      // Status lines and streamed model output share one bubble in the chat,
      // and share one row here.
      case "build:thinking":
      case "build:token": {
        const text = str("text") || str("token");
        if (!text) return;
        const state = stateFor(sessionId);
        state.openThinking = (state.openThinking ?? "") + text;
        return;
      }

      // Recorded when the tool finishes rather than when it is requested: the
      // completed line is what is worth reading back, and it avoids updating a
      // row that a dead process would leave unfinished.
      case "build:tool_result": {
        const tool = str("tool") || str("name") || "tool";
        closeThinking(sessionId);

        // Diffs are stored, not re-derived: the sandbox the files came from is
        // gone by the time anyone reloads, so whatever is not written here is
        // lost. The budget is why it is not simply all of them — a long build
        // would otherwise carry a megabyte of hunks through every read of its
        // history. When it does not fit, the counts survive and the flag says
        // the lines did not, which is better than a view that looks empty.
        const diffs = Array.isArray(data["diffs"]) ? data["diffs"] : undefined;
        const keepDiffs = diffs && JSON.stringify(diffs).length <= 6_000;

        write(sessionId, "tool", tool, {
          tool,
          ...(str("id") ? { toolCallId: str("id") } : {}),
          ok: data["success"] !== false && data["ok"] !== false,
          ...(str("label") ? { label: str("label") } : {}),
          ...(Array.isArray(data["paths"]) ? { paths: data["paths"] } : {}),
          ...(Array.isArray(data["deleted"]) ? { deleted: data["deleted"] } : {}),
          ...(str("delta") ? { delta: str("delta") } : {}),
          ...(keepDiffs ? { diffs } : {}),
          ...(diffs && !keepDiffs ? { diffsDropped: true } : {}),
        });
        return;
      }

      case "build:checks": {
        // Not a message of its own: it has no place in a transcript read back
        // as prose, and it belongs to the reply it accompanies.
        stateFor(sessionId).checks = {
          rows: data["rows"],
          missing: data["missing"],
          repairs: data["repairs"],
        };
        return;
      }

      // An MCP call is a tool call the agent made against somebody else's
      // service, and it was the one kind that left no trace at all: 0 of 1,482
      // recorded build events mention MCP, and nothing reached build_messages
      // either. So it never appeared in the transcript, never survived a
      // reload, and there was no way to answer "has an MCP ever actually run"
      // from the data. Measured 2026-10-23.
      case "build:mcp_tool_call": {
        const tool = str("tool") || "tool";
        const server = str("server");
        closeThinking(sessionId);
        write(sessionId, "tool", server ? `${server}.${tool}` : tool, {
          tool,
          mcp: true,
          ...(server ? { server } : {}),
          label: server ? `Used ${server} — ${tool}` : `Used ${tool}`,
          ok: str("result") !== "error",
        });
        return;
      }

      case "build:complete": {
        closeThinking(sessionId);
        const summary = str("summary");
        const checks = stateFor(sessionId).checks;
        if (summary) {
          write(sessionId, "assistant", summary, {
            hint: str("hint") || undefined,
            ...(checks ? { checks } : {}),
          });
        }
        sessions.delete(sessionId);
        return;
      }

      case "build:failed":
      case "build:error": {
        closeThinking(sessionId);
        write(sessionId, "error", str("error") || str("message") || "This build failed.");
        sessions.delete(sessionId);
        return;
      }

      case "build:cancelled": {
        closeThinking(sessionId);
        write(sessionId, "error", "This build was cancelled.");
        sessions.delete(sessionId);
        return;
      }

      default:
        return;
    }
  } catch (err) {
    // Recording history must never be the reason an event fails to send.
    logger.warn({ sessionId, event, err }, "[history] recorder threw");
  }
}

/** A session's messages, oldest first. */
export async function loadMessages(
  sessionId: string,
): Promise<{ role: Role; content: string; metadata: Record<string, unknown>; createdAt: Date }[]> {
  const rows = await db
    .select({
      role: buildMessages.role,
      content: buildMessages.content,
      metadata: buildMessages.metadata,
      createdAt: buildMessages.createdAt,
    })
    .from(buildMessages)
    .where(eq(buildMessages.sessionId, sessionId))
    .orderBy(buildMessages.seq);
  return rows as { role: Role; content: string; metadata: Record<string, unknown>; createdAt: Date }[];
}
