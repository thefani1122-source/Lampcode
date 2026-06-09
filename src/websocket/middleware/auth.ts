import type { Socket } from "socket.io";
import { getSupabaseAdmin } from "../../auth/supabase-server.js";
import { type SocketData } from "../types.js";

// Embed an HTTP-style code in the Socket.IO error so clients can distinguish
// 401 (no/bad token) from 403 (valid user, wrong owner) on connect_error.
function authError(message: string, code: 401 | 403): Error {
  return Object.assign(new Error(message), { data: { code } });
}

export async function wsAuthMiddleware(
  socket: Socket<object, object, object, SocketData>,
  next: (err?: Error) => void,
): Promise<void> {
  const auth = socket.handshake.auth as Record<string, unknown>;
  const token = auth["token"];
  if (typeof token !== "string" || token.length === 0) {
    next(new Error("No token provided"));
    return;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      next(new Error("Invalid or expired token"));
      return;
    }
    socket.data.userId = user.id;
    next();
  } catch (err) {
    next(new Error("Auth verification failed"));
  }
}

/**
 * Same token validation as wsAuthMiddleware but used on the /build namespace.
 * Embeds { code: 401 } in the error so clients can distinguish auth failures
 * from ownership failures (403, enforced in the connection handler).
 */
export async function wsBuildAuthMiddleware(
  socket: Socket<object, object, object, SocketData>,
  next: (err?: Error) => void,
): Promise<void> {
  const auth = socket.handshake.auth as Record<string, unknown>;
  const token = auth["token"];
  if (typeof token !== "string" || token.length === 0) {
    next(authError("Unauthorized", 401));
    return;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      next(authError("Unauthorized", 401));
      return;
    }
    socket.data.userId = user.id;
    next();
  } catch {
    next(authError("Unauthorized", 401));
  }
}
