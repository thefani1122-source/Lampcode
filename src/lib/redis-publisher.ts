import { createRedis } from "./redis.js"

const pub = createRedis()

export type BuildEvent =
  | { type: "token"; agent: string; content: string }
  | { type: "agent_status"; agent: string; status: "running" | "done" | "error"; statusText?: string }
  | { type: "file_created"; path: string; content: string }
  | { type: "build_complete"; files: Record<string, string> }
  | { type: "build_error"; error: string }
  | { type: "phase_change"; phase: string; label: string }

export async function publishBuildEvent(
  sessionId: string,
  event: BuildEvent
): Promise<void> {
  try {
    await pub.publish(`build:${sessionId}`, JSON.stringify(event))
  } catch (err) {
    console.error("[Redis Pub] Failed to publish:", sessionId, err)
  }
}
