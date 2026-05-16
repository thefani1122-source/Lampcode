import { type Socket } from "socket.io";
import { z } from "zod";
import { logger } from "../../server/logger.js";
import { type SocketData } from "../types.js";

// Reuse the same JWT payload shape as the HTTP middleware
const jwtPayloadSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
  exp: z.number(),
  iat: z.number(),
});

function decodeJwtPayload(token: string): z.infer<typeof jwtPayloadSchema> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const payloadPart = parts[1];
  if (!payloadPart) throw new Error("Malformed JWT payload");

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new Error("JWT payload is not valid JSON");
  }

  const result = jwtPayloadSchema.safeParse(raw);
  if (!result.success) throw new Error("Invalid JWT claims");

  if (Date.now() / 1000 > result.data.exp) throw new Error("JWT expired");

  return result.data;
}

function extractToken(socket: Socket): string | null {
  // Prefer auth object (recommended Socket.io pattern)
  const authToken = (socket.handshake.auth as Record<string, unknown>)["token"];
  if (typeof authToken === "string" && authToken.length > 0) return authToken;

  // Fall back to query parameter for clients that can't set headers
  const queryToken = socket.handshake.query["token"];
  if (typeof queryToken === "string" && queryToken.length > 0) return queryToken;

  return null;
}

/**
 * Socket.io middleware that verifies a JWT and populates socket.data.
 * Rejects the connection with an Error if auth fails.
 */
export function wsAuthMiddleware(
  socket: Socket<object, object, object, SocketData>,
  next: (err?: Error) => void,
): void {
  const token = extractToken(socket);

  if (token === null) {
    logger.warn({ socketId: socket.id }, "WS connection rejected: missing token");
    next(new Error("UNAUTHORIZED"));
    return;
  }

  try {
    const payload = decodeJwtPayload(token);
    socket.data.userId = payload.sub;
    socket.data.email = payload.email;
    logger.debug({ userId: payload.sub, socketId: socket.id }, "WS connection authenticated");
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Auth error";
    logger.warn({ socketId: socket.id, err: message }, "WS connection rejected: invalid token");
    next(new Error(message));
  }
}
