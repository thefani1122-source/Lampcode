// In-process store for ask_user questions. Mirrors pending-approvals.ts
// deliberately: same Map-per-process shape, same session-identity check, same
// sweep on disconnect. The only real difference is what comes back — an
// approval is a boolean, an answer is the user's words.
//
// Crash/restart: the Map is gone and the awaiting executeTool() never resumes.
// That fails SAFE here in the same way it does for approvals — a build that
// cannot get an answer does nothing rather than guessing one.

/** Longer than the 120 s approval window on purpose. An approval is a reflex —
 *  the user already knows whether they want the repo created. A question asks
 *  them to make a decision about their own product, sometimes reading options
 *  they have not thought about, and timing that out in two minutes would
 *  mostly produce the fallback rather than an answer. */
export const ANSWER_TIMEOUT_MS = 600_000; // 10 minutes

type PendingEntry = {
  sessionId: string;
  resolve: (answer: string | null) => void;
};

const pendingAnswers = new Map<string, PendingEntry>();

/** Register a pending question. Resolves with the user's answer, or null when
 *  it is swept/timed out — null meaning "no answer", never a guessed one. */
export function createPendingAnswer(toolCallId: string, sessionId: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pendingAnswers.set(toolCallId, { sessionId, resolve });
  });
}

/** Resolve a pending question. False when the toolCallId is unknown/expired or
 *  the session does not match — the same identity check as approvals, because
 *  an answer steers what gets built and must not be injectable by id alone. */
export function resolveAnswer(toolCallId: string, fromSessionId: string, answer: string): boolean {
  const entry = pendingAnswers.get(toolCallId);
  if (!entry) return false;
  if (entry.sessionId !== fromSessionId) return false;
  pendingAnswers.delete(toolCallId);
  entry.resolve(answer);
  return true;
}

/** Abandon every pending question for a session — called on WS disconnect, so
 *  a build cannot sit for ten minutes waiting on a client that has gone. */
export function sweepAnswersBySession(sessionId: string): void {
  for (const [toolCallId, entry] of pendingAnswers) {
    if (entry.sessionId === sessionId) {
      pendingAnswers.delete(toolCallId);
      entry.resolve(null);
    }
  }
}
