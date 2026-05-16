import { type Socket } from "socket.io";
import { logger } from "../../server/logger.js";
import { type SocketData } from "../types.js";

const MAX_CONNECTIONS_PER_USER = 5;

// userId → set of socket IDs currently open
const connectionsByUser = new Map<string, Set<string>>();

/**
 * Track this socket in the per-user connection map.
 * Must be called after wsAuthMiddleware has populated socket.data.userId.
 */
export function wsRateLimitMiddleware(
  socket: Socket<object, object, object, SocketData>,
  next: (err?: Error) => void,
): void {
  const userId = socket.data.userId;
  if (!userId) {
    next(new Error("UNAUTHORIZED"));
    return;
  }

  const existing = connectionsByUser.get(userId) ?? new Set<string>();

  if (existing.size >= MAX_CONNECTIONS_PER_USER) {
    logger.warn(
      { userId, current: existing.size, max: MAX_CONNECTIONS_PER_USER },
      "WS connection rejected: per-user connection limit reached",
    );
    next(new Error("TOO_MANY_CONNECTIONS"));
    return;
  }

  existing.add(socket.id);
  connectionsByUser.set(userId, existing);

  // Clean up when socket disconnects
  socket.once("disconnect", () => {
    const conns = connectionsByUser.get(userId);
    if (conns !== undefined) {
      conns.delete(socket.id);
      if (conns.size === 0) connectionsByUser.delete(userId);
    }
  });

  next();
}

/** Exposed for tests and metrics. */
export function getConnectionCount(userId: string): number {
  return connectionsByUser.get(userId)?.size ?? 0;
}
