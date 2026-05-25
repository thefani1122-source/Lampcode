import { Queue } from "bullmq";
import { createRedis } from "../lib/redis.js";

export interface FastBuildJobData {
  sessionId: string;
  projectId: string;
  userId: string;
  prompt: string;
}

let _queue: Queue<FastBuildJobData> | null = null;

function getFastBuildQueue(): Queue<FastBuildJobData> {
  if (_queue !== null) return _queue;
  _queue = new Queue<FastBuildJobData>("fast-build", {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  });
  // Without this handler Node would crash on Redis connection errors.
  _queue.on("error", (err) => {
    console.error(`[bullmq:queue] error: ${err.message}`);
  });
  return _queue;
}

export async function enqueueFastBuild(data: FastBuildJobData): Promise<string> {
  const queue = getFastBuildQueue();
  const job = await queue.add("fast-build", data, {
    jobId: `fast--${data.sessionId}`,
  });
  return job.id ?? data.sessionId;
}

export async function closeFastBuildQueue(): Promise<void> {
  if (_queue !== null) {
    await _queue.close();
    _queue = null;
  }
}
