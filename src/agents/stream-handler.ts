import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { WebSocketServer } from "../websocket/server.js"
import type { StreamChunk } from "./model-gateway.js"
import { parseFilesFromContent } from "./file-parser.js"

// Re-export so dispatcher.ts can still do:
//   import { type StreamChunk as HandlerStreamChunk } from "./stream-handler.js"
export type { StreamChunk }

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

  // Accumulates every file emitted via build:file_write so build:complete
  // can hand the full Record<string, string> to the frontend in one shot.
  const filesMap = new Map<string, string>()

  // All build: events go to the BARE sessionId room so the frontend receives
  // them after: socket.emit('join', sessionId)  →  socket.join(sessionId)
  const emit = (event: string, data: Record<string, unknown>): void =>
    wsServer.emitToRoom(sessionId, event, data)

  // ── Stream loop ─────────────────────────────────────────────────────────────
  try {
    for await (const chunk of generator) {
      switch (chunk.type) {
        // Reasoning / thinking tokens (DeepSeek R1, o1, etc.)
        case "reasoning":
          if (chunk.reasoning) {
            emit("build:thinking", { text: chunk.reasoning, sessionId })
          }
          break

        // Normal response tokens
        case "content":
          if (chunk.content) {
            console.log('[stream] token chunk:', JSON.stringify({ type: chunk.type, content: chunk.content?.slice(0, 80) }))
            fullContent += chunk.content
            emit("build:token", { text: chunk.content, sessionId })
          }
          break

        // Tool-call announced by the model (before execution)
        case "tool_call":
          if (chunk.toolCall) {
            emit("build:tool_call", {
              tool: chunk.toolCall.name,
              args: chunk.toolCall.arguments,
              sessionId,
            })
          }
          break

        // usage / done carry no UI-relevant data
        case "usage":
        case "done":
          break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit("build:error", { message, sessionId })
    throw err
  }

  // ── Write raw LLM output to disk (for audit / replay) ──────────────────────
  try {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, fullContent, "utf-8")
  } catch (err) {
    console.error("[StreamHandler] Output file write failed:", err)
  }

  // ── Parse files and emit file events ───────────────────────────────────────
  // Disk writes for the project workspace are still handled by build.ts so
  // the correct outputDir (workspace/{projectId}/{sessionId}/frontend) is used.
  // Here we only parse content to emit the WS events the FileTree needs.
  // Skip pure analysis agents that never produce file output.
  const skipFileEmit = ["security", "connection", "monitor"].includes(agentType ?? "");
  if (!skipFileEmit && fullContent.length > 0) {
    const parsedFiles = parseFilesFromContent(fullContent)

    for (const file of parsedFiles) {
      filesMap.set(file.path, file.code)

      // build:file_write — FileTree populates from these
      emit("build:file_write", {
        path: file.path,
        content: file.code,
        sessionId,
      })

      // build:tool_result — confirms write succeeded
      emit("build:tool_result", {
        tool: "write_file",
        result: "success",
        sessionId,
      })
    }

    // build:complete — send the full file map once all files are done
    emit("build:complete", {
      files: Object.fromEntries(filesMap),
      sessionId,
      totalFiles: filesMap.size,
    })
  }

  return fullContent
}
