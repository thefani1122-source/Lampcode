import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { WebSocketServer } from "../websocket/server.js"
import type { StreamChunk } from "./model-gateway.js"
import { parseFilesFromContent } from "./file-parser.js"

// Re-export so dispatcher.ts can still do:
//   import { type StreamChunk as HandlerStreamChunk } from "./stream-handler.js"
export type { StreamChunk }

export interface StreamResult {
  content: string
  inputTokens: number
  outputTokens: number
  stopReason?: string | undefined
  toolCalls: Array<{ id: string; name: string; arguments: string }>
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
): Promise<StreamResult> {
  const { sessionId, agentType, taskId, outputPath, wsServer } = opts
  let fullContent = ""
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: string | undefined

  // Accumulates every file emitted via build:file_write so build:complete
  // can hand the full Record<string, string> to the frontend in one shot.
  const filesMap = new Map<string, string>()

  // Accumulates every tool_use block the model requested this turn, so the
  // caller (dispatcher.ts's tool loop) can execute them and continue the
  // conversation. Empty when tools weren't offered or none were called.
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []

  // All build: events go to the BARE sessionId room so the frontend receives
  // them after: socket.emit('join', sessionId)  →  socket.join(sessionId)
  const emit = (event: string, data: Record<string, unknown>): void =>
    wsServer.emitToRoom(sessionId, event, data)

  // Only emit thinking text that appears BEFORE the first code fence.
  // Claude Sonnet sometimes streams the entire response as one large chunk,
  // making per-chunk fence detection unreliable. Instead we gate on whether
  // fullContent already contains a fence, which is always accurate.
  let codeStarted = false
  let chunkCount = 0
  let contentChunkCount = 0
  let lastEmittedWritingFile = ""
  let lastFenceCount = 0

  // ── Kick off with an immediate progress message so the chat panel isn't blank
  emit("build:thinking", { text: "Analyzing your prompt and planning the build...", sessionId })

  // ── Stream loop ─────────────────────────────────────────────────────────────
  try {
    for await (const chunk of generator) {
      chunkCount++

      switch (chunk.type) {
        // Reasoning / thinking tokens (DeepSeek R1, o1, etc.)
        case "reasoning":
          if (chunk.reasoning) {
            emit("build:thinking", { text: chunk.reasoning, sessionId })
          }
          break

        // Normal response tokens
        case "content": {
          // Accumulate unconditionally — ALWAYS first, before any branch
          const text = chunk.content ?? ""
          fullContent += text

          if (!text) break

          contentChunkCount++
          console.log(`[stream] content chunk #${contentChunkCount}, len=${text.length}, total=${fullContent.length}`)

          // Mark code as started the moment a fence appears anywhere in fullContent
          if (!codeStarted && fullContent.includes("```filename:")) {
            codeStarted = true
          }

          if (!codeStarted) {
            // Forward pre-code planning/explanation text to the thinking panel
            emit("build:thinking", { text, sessionId })
          } else {
            // Detect file transitions — scan only when fence count may have changed
            const fenceMatches = [...fullContent.matchAll(/```filename:([^\n]+)/g)]
            if (fenceMatches.length > lastFenceCount) {
              lastFenceCount = fenceMatches.length
              const capturedFile = fenceMatches[fenceMatches.length - 1]?.[1]?.trim()
              if (capturedFile && capturedFile !== lastEmittedWritingFile) {
                if (lastEmittedWritingFile) {
                  emit("build:file_done", { filename: lastEmittedWritingFile, sessionId })
                }
                emit("build:file_writing", { filename: capturedFile, sessionId })
                lastEmittedWritingFile = capturedFile
              }
            }
          }
          break
        }

        // Tool-call announced by the model (before execution)
        case "tool_call":
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall)
            emit("build:tool_call", {
              tool: chunk.toolCall.name,
              args: chunk.toolCall.arguments,
              sessionId,
            })
          }
          break

        case "usage":
          if (chunk.usage) {
            inputTokens = chunk.usage.promptTokens ?? 0
            outputTokens = chunk.usage.completionTokens ?? 0
          }
          break

        case "done":
          if (chunk.stopReason) stopReason = chunk.stopReason
          break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit("build:error", { message, sessionId })
    throw err
  }

  console.log(`[stream] loop done: totalChunks=${chunkCount} contentChunks=${contentChunkCount} fullContentLen=${fullContent.length} stopReason=${stopReason}`)

  // Close the last file that was being written
  if (lastEmittedWritingFile) {
    emit("build:file_done", { filename: lastEmittedWritingFile, sessionId })
  }

  if (stopReason === "max_tokens") {
    emit("build:warning", {
      message: "Generation was cut off — some files may be incomplete. Try rebuilding or simplifying the request.",
      truncated: true,
      sessionId,
    })
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

    // NOTE: build:complete is intentionally NOT emitted here.
    // build.ts (runFastBuild) emits the single authoritative build:complete
    // AFTER files are written to disk, with files + previewUrl + totalFiles.
    // Emitting here too caused a duplicate event reaching the frontend.
  }

  return { content: fullContent, inputTokens, outputTokens, stopReason, toolCalls }
}
