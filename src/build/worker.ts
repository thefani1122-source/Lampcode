import { Worker } from "bullmq";
import { createRedis } from "../lib/redis.js";
import { logger } from "../server/logger.js";
import type { FastBuildJobData } from "./queue.js";
import type { WebSocketServer } from "../websocket/server.js";

export type FastBuildRunner = (
  sessionId: string,
  projectId: string,
  prompt: string,
  userId: string,
) => Promise<void>;

let _worker: Worker<FastBuildJobData> | null = null;

export function startFastBuildWorker(runner: FastBuildRunner, wsServer?: WebSocketServer): void {
  if (_worker !== null) {
    logger.warn("Fast build worker already started — skipping");
    return;
  }

  _worker = new Worker<FastBuildJobData>(
    "fast-build",
    async (job) => {
      const { sessionId, projectId, prompt, userId } = job.data;
      logger.info({ sessionId, projectId }, "Fast build job starting");
      await runner(sessionId, projectId, prompt, userId);
    },
    {
      connection: createRedis(),
      concurrency: 3,
    },
  );

  // Without this handler Node would crash on Redis connection errors.
  _worker.on("error", (err) => {
    logger.error({ err: err.message }, "Fast build worker error");
  });

  _worker.on("active", async (job) => {
    const { sessionId } = job.data
    if (sessionId && wsServer) {
      await wsServer.startBuildSession(sessionId)
    }
  })

  _worker.on("completed", async (job) => {
    const { sessionId } = job.data
    if (sessionId && wsServer) {
      setTimeout(() => wsServer.endBuildSession(sessionId), 5000)
    }
  })

  _worker.on("failed", async (job) => {
    if (!job) return
    const { sessionId } = job.data
    if (sessionId) {
      const { publishBuildEvent } = await import("../lib/redis-publisher.js")
      await publishBuildEvent(sessionId, {
        type: "build_error",
        error: job.failedReason ?? "Build failed",
      })
      if (wsServer) wsServer.endBuildSession(sessionId)
    }
  })

  logger.info("Fast build worker started (concurrency: 3)");
}

export async function closeFastBuildWorker(): Promise<void> {
  if (_worker !== null) {
    await _worker.close();
    _worker = null;
  }
}
