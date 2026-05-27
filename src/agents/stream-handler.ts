import { publishBuildEvent } from "../lib/redis-publisher.ts"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface StreamChunk {
  type: "content" | "done" | "error"
  content?: string
  error?: string
  usage?: { prompt_tokens: number; completion_tokens: number }
}

export async function handleAgentStream(
  generator: AsyncGenerator<StreamChunk>,
  opts: {
    sessionId: string
    agentType: string
    taskId: string
    outputPath: string
  }
): Promise<string> {
  const { sessionId, agentType, taskId, outputPath } = opts
  let fullContent = ""

  await publishBuildEvent(sessionId, {
    type: "agent_status",
    agent: agentType,
    status: "running",
    statusText: "Starting...",
  })

  for await (const chunk of generator) {
    if (chunk.type === "error") {
      await publishBuildEvent(sessionId, {
        type: "build_error",
        error: chunk.error ?? "Unknown error",
      })
      throw new Error(chunk.error)
    }

    if (chunk.type === "content" && chunk.content) {
      fullContent += chunk.content
      await publishBuildEvent(sessionId, {
        type: "token",
        agent: agentType,
        content: chunk.content,
      })
    }

    if (chunk.type === "done") {
      await publishBuildEvent(sessionId, {
        type: "agent_status",
        agent: agentType,
        status: "done",
        statusText: "Complete",
      })
      break
    }
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, fullContent, "utf-8")
  } catch (err) {
    console.error("[StreamHandler] File write failed:", err)
  }

  return fullContent
}
