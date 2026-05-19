import { type Namespace, type Socket } from "socket.io";
import { logger } from "../../server/logger.js";
import type {
  InterviewServerEvents,
  InterviewClientEvents,
  InterviewQuestionEvent,
  InterviewContractEvent,
  InterviewApprovedEvent,
  SocketData,
} from "../types.js";

type InterviewNsp = Namespace<InterviewClientEvents, InterviewServerEvents, object, SocketData>;
type InterviewSocket = Socket<InterviewClientEvents, InterviewServerEvents, object, SocketData>;

const SESSION_ROOM = (sessionId: string) => `interview:${sessionId}`;

export function registerInterviewHandlers(nsp: InterviewNsp): void {
  nsp.on("connection", (socket: InterviewSocket) => {
    const userId = socket.data.userId;
    logger.info({ socketId: socket.id, userId }, "Interview WS connected");

    socket.on("join_session", (sessionId, ack) => {
      void socket.join(SESSION_ROOM(sessionId));
      logger.debug({ socketId: socket.id, sessionId }, "Joined interview session room");
      ack(true);
    });

    socket.on("leave_session", (sessionId) => {
      void socket.leave(SESSION_ROOM(sessionId));
      logger.debug({ socketId: socket.id, sessionId }, "Left interview session room");
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "Interview WS disconnected");
    });
  });
}

export function emitInterviewQuestion(
  nsp: InterviewNsp,
  sessionId: string,
  data: InterviewQuestionEvent,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("interview:question", data);
}

export function emitInterviewContract(
  nsp: InterviewNsp,
  sessionId: string,
  data: InterviewContractEvent,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("interview:contract", data);
}

export function emitInterviewApproved(
  nsp: InterviewNsp,
  sessionId: string,
  data: InterviewApprovedEvent,
): void {
  nsp.to(SESSION_ROOM(sessionId)).emit("interview:approved", data);
}
