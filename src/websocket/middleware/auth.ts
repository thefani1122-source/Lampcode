import type { Socket } from "socket.io";
import { getSupabaseAdmin } from "../../auth/supabase-server.js";
import { type SocketData } from "../types.js";

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
