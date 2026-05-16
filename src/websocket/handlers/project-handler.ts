import { type Namespace, type Socket } from "socket.io";
import { logger } from "../../server/logger.js";
import {
  type ProjectServerEvents,
  type ProjectClientEvents,
  type SocketData,
} from "../types.js";

type ProjectNamespace = Namespace<ProjectClientEvents, ProjectServerEvents, object, SocketData>;
type ProjectSocket = Socket<ProjectClientEvents, ProjectServerEvents, object, SocketData>;

const PROJECT_ROOM = (projectId: string) => `project:${projectId}`;

export function registerProjectHandlers(nsp: ProjectNamespace): void {
  nsp.on("connection", (socket: ProjectSocket) => {
    const userId = socket.data.userId;
    logger.info({ socketId: socket.id, userId }, "Project WS connected");

    socket.on("join_project", (projectId, ack) => {
      void socket.join(PROJECT_ROOM(projectId));
      logger.debug({ socketId: socket.id, projectId }, "Joined project room");
      ack(true);
    });

    socket.on("leave_project", (projectId) => {
      void socket.leave(PROJECT_ROOM(projectId));
      logger.debug({ socketId: socket.id, projectId }, "Left project room");
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, userId, reason }, "Project WS disconnected");
    });
  });
}

// ── Emitter helpers ───────────────────────────────────────────────────────────

export function emitMemberJoined(
  nsp: ProjectNamespace,
  projectId: string,
  data: ProjectServerEvents["member_joined"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(PROJECT_ROOM(projectId)).emit("member_joined", data);
}

export function emitSettingsChanged(
  nsp: ProjectNamespace,
  projectId: string,
  data: ProjectServerEvents["settings_changed"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(PROJECT_ROOM(projectId)).emit("settings_changed", data);
}

export function emitIntegrationConnected(
  nsp: ProjectNamespace,
  projectId: string,
  data: ProjectServerEvents["integration_connected"] extends (e: infer E) => void ? E : never,
): void {
  nsp.to(PROJECT_ROOM(projectId)).emit("integration_connected", data);
}
