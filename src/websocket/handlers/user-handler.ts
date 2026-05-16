import { type Namespace, type Socket } from "socket.io";
import { logger } from "../../server/logger.js";
import {
  type UserServerEvents,
  type UserClientEvents,
  type SocketData,
} from "../types.js";

type UserNamespace = Namespace<UserClientEvents, UserServerEvents, object, SocketData>;
type UserSocket = Socket<UserClientEvents, UserServerEvents, object, SocketData>;

const USER_ROOM = (userId: string) => `user:${userId}`;

export function registerUserHandlers(nsp: UserNamespace): void {
  nsp.on("connection", (socket: UserSocket) => {
    const userId = socket.data.userId;
    logger.info({ socketId: socket.id, userId }, "User WS connected");

    // Automatically join the user's own room — no need for a separate join event
    void socket.join(USER_ROOM(userId));

    socket.on("subscribe", (ack) => {
      // Already subscribed on connection; just acknowledge
      ack(true);
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "User WS disconnected");
    });
  });
}

// ── Emitter helpers ───────────────────────────────────────────────────────────

export function emitNotification(
  nsp: UserNamespace,
  userId: string,
  data: UserServerEvents["notification"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(USER_ROOM(userId)).emit("notification", data);
}

export function emitCreditLow(
  nsp: UserNamespace,
  userId: string,
  data: UserServerEvents["credit_low"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(USER_ROOM(userId)).emit("credit_low", data);
}

export function emitBuildComplete(
  nsp: UserNamespace,
  userId: string,
  data: UserServerEvents["build_complete"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(USER_ROOM(userId)).emit("build_complete", data);
}
