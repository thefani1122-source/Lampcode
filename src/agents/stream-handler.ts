import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { WebSocketServer } from "../websocket/server.js"
import type { StreamChunk } from "./model-gateway.js"
import { parseFilesFromContent } from "./file-parser.js"
import { narrateTool } from "./tool-narration.js"
import { PseudoToolFilter } from "./pseudo-tools.js"

// Re-export so dispatcher.ts can still do:
//   import { type StreamChunk as HandlerStreamChunk } from "./stream-handler.js"
export type { StreamChunk }

export interface StreamResult {
  content: string
  inputTokens: number
  /** Part of inputTokens the provider served from its own cache. */
  cachedInputTokens: number
  /** Prompt tokens written INTO the provider's cache, billed above the normal
   *  input rate. Zero on providers that do not charge for a cache write. */
  cacheWriteTokens: number
  outputTokens: number
  stopReason?: string | undefined
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  mcpToolCalls: Array<{ id: string; name: string; serverName: string; isError: boolean }>
  /** Tool names the model TYPED as text instead of calling. Empty is the normal
   *  case; non-empty means a round produced pseudo-tool markup, which was kept
   *  out of the user's chat and is a lost round. See pseudo-tools.ts. */
  pseudoToolNames: string[]
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
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let stopReason: string | undefined

  // Accumulates every file emitted via build:file_write so build:complete
  // can hand the full Record<string, string> to the frontend in one shot.
  const filesMap = new Map<string, string>()

  // Accumulates every tool_use block the model requested this turn, so the
  // caller (dispatcher.ts's tool loop) can execute them and continue the
  // conversation. Empty when tools weren't offered or none were called.
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []

  // MCP tool calls are already fully resolved (request + result) by the time
  // they reach us — nothing for the caller to execute, just observe.
  const mcpToolCalls: Array<{ id: string; name: string; serverName: string; isError: boolean }> = []

  // All build: events go to the BARE sessionId room so the frontend receives
  // them after: socket.emit('join', sessionId)  →  socket.join(sessionId)
  const emit = (event: string, data: Record<string, unknown>): void =>
    wsServer.emitToRoom(sessionId, event, data)

  /**
   * Passes that produce structured data for the system, not reasoning a person
   * should watch.
   *
   * These dispatch on the USER'S sessionId — they have to, for cost attribution
   * and logging — so every token they stream landed in the user's chat as
   * "thinking". Observed in production 2026-10-14: a notes-app build opened with
   *
   *     { "criteria": [ { "text": "User can create new notes", "kind": …
   *
   * sitting in the THOUGHTS panel. That is the acceptance pass talking to the
   * audit, rendered as though the builder were thinking out loud in JSON.
   *
   * Narration exists to show what the BUILD agent is doing. `frontend`,
   * `backend` and `fix` are that agent; the rest are plumbing, and their
   * results already reach the user through their own formatters —
   * `formatCriteriaForUser` and `formatAuditForUser` — written in the user's
   * words rather than the model's raw output.
   *
   * `planning` was listed as a build agent here and left out of the set below,
   * and that was wrong for the same reason the other three are in it: the
   * planning prompt says "Output ONLY this JSON object", so narrating it puts
   *
   *     { "summary": "A minimal B2B SaaS starter...", "approach": [ ...
   *
   * in the chat, which is the identical failure this comment was written about.
   * It stayed hidden while planning ran on perhaps one build in five; making
   * every build plan (2026-10-23) put it in front of every user at once. The
   * user already gets a written line for this pass — "Planning the file
   * layout…", then the plan's own summary — so nothing is lost by silencing it.
   */
  const SILENT_AGENT_TYPES = new Set(["acceptance", "audit", "review", "planning"])
  const narrate = (event: string, data: Record<string, unknown>): void => {
    if (SILENT_AGENT_TYPES.has(agentType)) return
    emit(event, data)
  }

  let codeStarted = false
  let chunkCount = 0
  let contentChunkCount = 0
  let lastEmittedWritingFile = ""
  let lastFenceCount = 0

  // Tool-call syntax the model types instead of calling. Filtered on the way
  // to the chat, never on the way into fullContent: the raw output is still
  // written to disk for replay, and the parser must see exactly what arrived.
  const pseudoFilter = new PseudoToolFilter()
  const pseudoReasoning = new PseudoToolFilter()

  // ── Kick off with an immediate progress message so the chat panel isn't blank
  narrate("build:thinking", {
    text: "Understanding your request",
    sessionId,
    internal: true,
  })

  // ── Stream loop ─────────────────────────────────────────────────────────────
  try {
    for await (const chunk of generator) {
      chunkCount++

      switch (chunk.type) {
        // Reasoning / thinking tokens (DeepSeek R1, Claude extended thinking, o1, etc.)
        case "reasoning":
          // Provider reasoning is internal model output, never user-facing progress.
          // Still feed it through the pseudo-tool filter so typed tool syntax is
          // detected and kept out of the chat.
          if (chunk.reasoning) pseudoReasoning.push(chunk.reasoning)
          break

        // Normal response tokens
        case "content": {
          // Accumulate unconditionally — ALWAYS first, before any branch
          const text = chunk.content ?? ""
          fullContent += text

          if (!text) break

          contentChunkCount++
          console.log(`[stream] content chunk #${contentChunkCount}, len=${text.length}, total=${fullContent.length}`)

          if (!codeStarted && (/```/.test(fullContent) || /^#{1,4}\s+\S+\.\w{1,10}\s*$/m.test(fullContent))) {
            codeStarted = true
          }

          // Keep parsing typed tool syntax for diagnostics, but do not expose
          // model planning prose as if it were a progress report.
          pseudoFilter.push(text)

          if (codeStarted) {
            // Detect file transitions — scan only when fence count may have changed.
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
            // `label`/`active` ride along so the chat can name the action
            // without owning a verb table for tools it does not define, and so
            // the live status line and the finished row always agree.
            const narration = narrateTool(chunk.toolCall.name, chunk.toolCall.arguments)
            emit("build:tool_call", {
              // The model's own id for this call. Without it the client had to
              // guess which row a result belonged to by matching the tool NAME
              // against the last row still running, so two calls to the same
              // tool could settle the wrong one.
              id: chunk.toolCall.id,
              tool: chunk.toolCall.name,
              args: chunk.toolCall.arguments,
              label: narration.label,
              active: narration.active,
              sessionId,
            })
          }
          break

        // MCP tool call — unlike tool_call above, this already ran server-side
        // (Anthropic's MCP connector has no interception point) — request and
        // result both arrive together, nothing left for us to execute.
        case "mcp_tool_call":
          if (chunk.mcpToolCall) {
            mcpToolCalls.push({
              id: chunk.mcpToolCall.id,
              name: chunk.mcpToolCall.name,
              serverName: chunk.mcpToolCall.serverName,
              isError: chunk.mcpToolCall.isError,
            })
            emit("build:mcp_tool_call", {
              tool: chunk.mcpToolCall.name,
              server: chunk.mcpToolCall.serverName,
              result: chunk.mcpToolCall.isError ? "error" : "success",
              sessionId,
            })
          }
          break

        case "usage":
          if (chunk.usage) {
            inputTokens = chunk.usage.promptTokens ?? 0
            cachedInputTokens = chunk.usage.cachedPromptTokens ?? 0
            cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0
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

  // Flush internal filters for diagnostics, but never emit raw provider
  // reasoning or pre-code planning prose as if it were verified build progress.
  // Structured progress is emitted through the initial phase and tool events.
  pseudoFilter.flush()
  pseudoReasoning.flush()

  const typedToolNames = [...new Set([...pseudoFilter.names(), ...pseudoReasoning.names()])]
  if (typedToolNames.length > 0) {
    console.warn(
      `[stream] model TYPED tool calls instead of calling them: ${typedToolNames.join(", ")} ` +
      `— kept out of the chat; the round produced ${toolCalls.length} real tool call(s)`,
    )
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

  return { content: fullContent, inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, stopReason, toolCalls, mcpToolCalls, pseudoToolNames: typedToolNames }
}
