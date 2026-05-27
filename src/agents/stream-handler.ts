import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { WebSocketServer } from "../websocket/server.js"

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
    wsServer: WebSocketServer
  }
): Promise<string> {
  const { sessionId, agentType, taskId, outputPath, wsServer } = opts
  let fullContent = ""

  wsServer.emitToSession(sessionId, "agent:update", {
    agent: agentType,
    status: "running",
    statusText: "Starting...",
    sessionId,
  })

  for await (const chunk of generator) {
    if (chunk.type === "error") {
      wsServer.emitToSession(sessionId, "build:error", {
        error: chunk.error ?? "Unknown error",
        sessionId,
      })
      throw new Error(chunk.error)
    }

    if (chunk.type === "content" && chunk.content) {
      fullContent += chunk.content
      wsServer.emitToSession(sessionId, "agent:token", {
        agent: agentType,
        content: chunk.content,
        sessionId,
      })
    }

    if (chunk.type === "done") {
      wsServer.emitToSession(sessionId, "agent:update", {
        agent: agentType,
        status: "done",
        statusText: "Complete",
        sessionId,
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
