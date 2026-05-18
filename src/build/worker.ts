import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import type { FastBuildJobData } from "./queue.js";

export type FastBuildRunner = (
  sessionId: string,
  projectId: string,
  prompt: string,
  userId: string,
) => Promise<void>;

let _worker: Worker<FastBuildJobData> | null = null;

export function startFastBuildWorker(runner: FastBuildRunner): void {
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
      connection: new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      }),
      concurrency: 3,
    },
  );

  _worker.on("completed", (job) => {
    logger.info({ sessionId: job.data.sessionId }, "Fast build job completed");
  });

  _worker.on("failed", (job, err) => {
    const sid = job?.data.sessionId ?? "unknown";
    logger.error({ sessionId: sid, err: err.message }, "Fast build job failed");
  });

  logger.info("Fast build worker started (concurrency: 3)");
}

export async function closeFastBuildWorker(): Promise<void> {
  if (_worker !== null) {
    await _worker.close();
    _worker = null;
  }
}
