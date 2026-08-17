// In-process store for write-MCP tool approvals. Each entry lives until the
// user decides, the 120 s timeout fires, or the session's WS disconnects.
// Process-level Map is safe for Railway's single-instance deployment.
// Crash/restart: the Map is gone, the awaiting executeTool() never resumes,
// no callTool() is ever made — fails safe by construction.

export const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

type PendingEntry = {
  sessionId: string;
  resolve: (approved: boolean) => void;
};

const pendingApprovals = new Map<string, PendingEntry>();

/** Register a pending approval. Returns a Promise that resolves true (approved)
 *  or false (denied/timeout/disconnect). Caller races this with a timeout. */
export function createPendingApproval(toolCallId: string, sessionId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(toolCallId, { sessionId, resolve });
  });
}

/** Resolve a pending approval. Returns true on success; false if the toolCallId
 *  is unknown/expired OR the fromSessionId doesn't match the stored one.
 *  The session-identity check is cheap but non-negotiable: this gates real
 *  destructive actions and must not trust toolCallId alone. */
export function resolveApproval(toolCallId: string, fromSessionId: string, approved: boolean): boolean {
  const entry = pendingApprovals.get(toolCallId);
  if (!entry) return false;
  if (entry.sessionId !== fromSessionId) return false;
  pendingApprovals.delete(toolCallId);
  entry.resolve(approved);
  return true;
}

/** Deny all pending approvals for a session — called on WS disconnect so no
 *  approval can be stranded forever waiting for a gone client. */
export function sweepBySession(sessionId: string): void {
  for (const [toolCallId, entry] of pendingApprovals) {
    if (entry.sessionId === sessionId) {
      pendingApprovals.delete(toolCallId);
      entry.resolve(false);
    }
  }
}
