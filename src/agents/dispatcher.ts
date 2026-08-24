import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "path";
import { z } from "zod";
import {
  ModelGateway,
  GatewayError,
  tierModel,
  MODEL_TIERS,
  type AgentTaskType,
  type ChatMessage,
  type MessageContentBlock,
  type McpServerDefinition,
} from "./model-gateway.js";
import { TokenTracker } from "./token-tracker.js";
import { PromptBuilder, type TaskInput } from "./prompt-builder.js";
import { handleAgentStream, type StreamChunk as HandlerStreamChunk, type StreamResult } from "./stream-handler.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import {
  classifyMcpServers,
  buildWriteProxyDefinitions,
  type McpToolsetConfig,
  type WriteProxyRegistry,
} from "./mcp-tool-classifier.js";
import { getWebSocketServer } from "../websocket/server.js";
import { logger } from "../server/logger.js";
import { deductUsage } from "../build/credits.js";
import type { UsageCategory } from "../db/schema.js";
import type { ActiveMcpServer, ConnectedRestProvider } from "../server/routes/integrations.js";

// Workspace root: one directory per project
const WORKSPACE_BASE = join(process.cwd(), "workspace");

// Max retries per tier before falling back to the next tier
const RETRIES_PER_TIER = 2;

// Max tool round-trips within a single dispatch's tool loop, one more than
// this codebase's usual bounded-retry convention of 2 (MAX_FIX_ATTEMPTS,
// MAX_TYPECHECK_ATTEMPTS, MAX_SECURITY_FIX_ATTEMPTS, RETRIES_PER_TIER above)
// because Anthropic allows multiple tool_use blocks in one turn — a build
// that wants several skills can batch them in one round trip, so this bounds
// round trips, not total tool calls.
const MAX_TOOL_ROUNDTRIPS = 3;

// ── AgentTaskType re-exported for external consumers ─────────────────────────
export { type AgentTaskType } from "./model-gateway.js";

// ── Dispatch request / result ─────────────────────────────────────────────────

export const dispatchOptionsSchema = z.object({
  agentType: z.string() as z.ZodType<AgentTaskType>,
  task: z.object({
    description: z.string().min(1),
    requirements: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    outputFormat: z.enum(["prose", "json", "code", "markdown"]).default("prose"),
    targetFiles: z.array(z.string()).optional(),
    hasReferenceImage: z.boolean().optional(),
    isAgentBuild: z.boolean().optional(),
    hasAnimationContext: z.boolean().optional(),
    projectMemory: z.string().nullable().optional(),
    projectManifest: z.string().nullable().optional(),
  }),
  sessionId: z.string().uuid(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
});

// contextFiles is injected internally after ContextManager.select() — not user-facing.
// enableTools/costGuard are opt-in per call site (today: only the main frontend
// build dispatch in build.ts) — omitting them keeps a dispatch byte-for-byte
// identical to pre-tool-calling behavior, which is how the 5 existing fix loops
// stay untouched despite sharing this same dispatch() method.
export type DispatchOptions = z.infer<typeof dispatchOptionsSchema> & {
  contextFiles?: Array<{ path: string; content: string }> | undefined;
  enableTools?: boolean | undefined;
  /** Required when enableTools is true — lets the in-loop cost check see the
   *  build's spend so far, not just this dispatch's own turns. */
  costGuard?: { cumulativeUsd: number; maxUsd: number } | undefined;
  /** User's connected MCP/REST services — only meaningful when enableTools is
   *  true. Read-only tools go to the Anthropic remote connector (denylist-
   *  classified). Explicitly-annotated write/destructive tools become local
   *  proxy tools with a user-approval gate. Ambiguous tools stay fully blocked. */
  mcpServers?: ActiveMcpServer[] | undefined;
  restProviders?: ConnectedRestProvider[] | undefined;
  /** Billing/analytics tag for this dispatch — separate from agentType, see
   *  the usageCategory column comment in db/schema.ts. Defaults to "build"
   *  when omitted so every dispatch still lands in a real category rather
   *  than null. */
  usageCategory?: UsageCategory | undefined;
};

export interface DispatchResult {
  taskId: string;
  modelUsed: string;
  tierUsed: number;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** MCP tool calls actually executed (server-side, already resolved) this dispatch. */
  mcpToolCalls: Array<{ id: string; name: string; serverName: string; isError: boolean }>;
  /** True if the model called request_write_action — a write/destructive
   *  action was needed but isn't available yet. Lets the caller distinguish
   *  "declined a write action" from "generation genuinely produced nothing". */
  requestedWriteAction: boolean;
  outputPath: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Errors that allow falling back to the next tier.
// UNKNOWN is included so a nonexistent model ID (HTTP 400) falls through
// to the next tier rather than crashing the build immediately.
const FALLBACK_CODES = new Set(["RATE_LIMIT", "MODEL_DOWN", "UNKNOWN"] as const);
type FallbackCode = "RATE_LIMIT" | "MODEL_DOWN" | "UNKNOWN";

function isFallbackCode(code: string): code is FallbackCode {
  return FALLBACK_CODES.has(code as FallbackCode);
}

// ── AgentDispatcher ───────────────────────────────────────────────────────────

export class AgentDispatcher {
  private readonly gateway: ModelGateway;
  private readonly tracker: TokenTracker;
  private readonly promptBuilder: PromptBuilder;

  constructor() {
    this.gateway = new ModelGateway();
    this.tracker = new TokenTracker();
    this.promptBuilder = new PromptBuilder();
  }

  /** Primary dispatch method — tries tier 1 → 2 → 3 on fallback errors, with per-tier retries. */
  async dispatch(options: DispatchOptions): Promise<DispatchResult> {
    const parsed = dispatchOptionsSchema.parse(options);
    const tiers = MODEL_TIERS[parsed.agentType];
    const task = parsed.task as TaskInput;
    // contextFiles/enableTools/costGuard/mcpServers/restProviders are not in
    // the Zod schema so read from original options
    const contextFiles = options.contextFiles;
    const enableTools = options.enableTools;
    const costGuard = options.costGuard;
    const mcpServers = options.mcpServers;
    const restProviders = options.restProviders;
    const usageCategory = options.usageCategory;

    let lastError: Error | null = null;

    for (let tier = 1; tier <= tiers.length; tier++) {
      const model = tierModel(parsed.agentType, tier as 1 | 2);

      try {
        return await this.callModelWithRetry(
          { ...parsed, contextFiles, enableTools, costGuard, mcpServers, restProviders, usageCategory },
          task, model, tier as 1 | 2,
        );
      } catch (err) {
        if (
          err instanceof GatewayError &&
          isFallbackCode(err.code) &&
          tier < tiers.length
        ) {
          const delay = err.retryAfterMs ?? 2_000;
          logger.warn(
            { agentType: parsed.agentType, model, tier, nextTier: tier + 1, delay },
            "Model fallback triggered",
          );
          await sleep(Math.min(delay, 10_000));
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error(`All tiers failed for ${parsed.agentType}`);
  }

  /** Trigger the fix agent after empty/malformed output from another agent. */
  async triggerFixAgent(
    failedAgentType: AgentTaskType,
    errorContext: string,
    sessionId: string,
    projectId?: string | undefined,
    userId?: string | undefined,
  ): Promise<DispatchResult> {
    logger.warn({ failedAgentType, sessionId }, "Auto-triggering fix agent");
    return this.dispatch({
      agentType: "fix",
      usageCategory: "empty_output_fix",
      task: {
        description: `The ${failedAgentType} agent produced no valid output. Context: ${errorContext.slice(0, 1_000)}. Diagnose the issue and regenerate the expected output.`,
        outputFormat: "code",
      },
      sessionId,
      projectId,
      userId,
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Retry up to RETRIES_PER_TIER times on NETWORK errors before re-throwing. */
  private async callModelWithRetry(
    options: DispatchOptions,
    task: TaskInput,
    model: string,
    tier: 1 | 2,
  ): Promise<DispatchResult> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= RETRIES_PER_TIER; attempt++) {
      try {
        return await this.callModel(options, task, model, tier);
      } catch (err) {
        if (err instanceof GatewayError && err.code === "NETWORK" && attempt < RETRIES_PER_TIER) {
          const delay = Math.pow(2, attempt) * 1_000; // 1 s, 2 s
          logger.warn({ model, tier, attempt: attempt + 1, delay }, "Network error — retrying");
          await sleep(delay);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("All retries exhausted");
  }

  private async callModel(
    options: DispatchOptions,
    task: TaskInput,
    model: string,
    tier: 1 | 2,
  ): Promise<DispatchResult> {
    const { agentType, sessionId, userId, projectId, contextFiles, costGuard, mcpServers, restProviders } = options;
    // Defaults to "build" rather than left null — every dispatch is billing-
    // relevant, and the 5 existing fix loops that predate this field (and
    // any future caller that forgets to set it) should still land in a real,
    // visible category rather than silently falling out of the breakdown.
    const usageCategory: UsageCategory = options.usageCategory ?? "build";

    // Tools require a costGuard so the in-loop check has something to check
    // against — a call site that forgets to pass one gets tools silently
    // disabled (safe default) rather than an unbounded loop.
    let enableTools = options.enableTools === true;
    if (enableTools && !costGuard) {
      logger.warn(
        { agentType, sessionId },
        "enableTools was set without a costGuard — disabling tools for this dispatch rather than looping unbounded",
      );
      enableTools = false;
    }

    // Discover + classify each connected server's real tools once per dispatch
    // (not per round — the classification doesn't change mid-loop). Read-only
    // tools (by MCP annotation or name convention) get enabled; everything
    // else — including anything discovery couldn't classify — stays denylisted.
    // The Anthropic MCP connector has no mid-call approval mechanism (confirmed
    // against its docs), so this denylist IS the safety boundary, not a hint.
    const mcpDefs: McpServerDefinition[] = [];
    let mcpToolsets: McpToolsetConfig[] = [];
    let writeProxyDefs: typeof TOOL_DEFINITIONS = [];
    let writeProxyRegistry: WriteProxyRegistry = new Map();
    if (enableTools && mcpServers && mcpServers.length > 0) {
      for (const s of mcpServers) {
        mcpDefs.push({ type: "url", url: s.url, name: s.slug, ...(s.authToken ? { authorization_token: s.authToken } : {}) });
      }
      const { toolsets, report } = await classifyMcpServers(mcpServers);
      mcpToolsets = toolsets;
      const writeProxies = buildWriteProxyDefinitions(report, mcpServers);
      writeProxyDefs = writeProxies.toolDefs;
      writeProxyRegistry = writeProxies.registry;
      logger.info(
        {
          sessionId,
          agentType,
          classification: report.map((r) => `${r.serverSlug}.${r.toolName}=${r.allowed ? "allow" : "deny"}(${r.reason})`),
          writeProxyCount: writeProxyDefs.length,
        },
        "MCP tool classification for this dispatch",
      );
    }

    // REST-only providers have no callable tool — their hint text goes into
    // the user message (never the cached system-prompt base, since it's
    // per-user credential-bearing content that shouldn't ride on a shared
    // cache segment). Mirrors mcp-action-agent.ts's existing interpolation.
    let restContext = "";
    if (enableTools && restProviders && restProviders.length > 0) {
      const entries = restProviders.map((rp) => {
        const hint = rp.restApiHint.replace(/\{(\w+)\}/g, (_m, key: string) => rp.creds[key] ?? `{${key}}`);
        return `### ${rp.name}\n${hint}`;
      });
      restContext = `\n\nAvailable REST APIs for connected services (call these directly, read-only lookups only — for write/destructive actions call request_write_action instead):\n${entries.join("\n\n")}`;
    }

    logger.info({ agentType, model, tier, sessionId, enableTools, mcpServerCount: mcpDefs.length }, "Dispatching agent");

    // Resolve workspace directory for project-specific brain files
    const workspaceDir = projectId !== undefined
      ? join(WORKSPACE_BASE, projectId)
      : undefined;

    // task.toolsEnabled drives prompt-builder.ts's TOOLS AVAILABLE instruction —
    // must match `enableTools` exactly, or the model gets told about a
    // capability it doesn't actually have this call (or vice versa).
    const effectiveTask: TaskInput = enableTools ? { ...task, toolsEnabled: true } : task;

    // Build prompt
    const { systemPrompt, userMessage, estimatedInputTokens } =
      await this.promptBuilder.build(agentType, effectiveTask, {
        projectId: projectId ?? "unknown",
        userId: userId ?? "anonymous",
        mode: "fast",
        prompt: task.description,
      }, workspaceDir, contextFiles);

    // Create DB row (don't block on failure — tracking is best-effort)
    const taskId = await this.tracker
      .begin(sessionId, agentType, model, tier, userId, projectId, usageCategory)
      .catch((err) => {
        logger.warn({ err }, "Failed to record agent task start");
        return randomUUID();
      });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage + restContext },
    ];

    // Frontend and fast agents generate full apps — give them 5 minutes and more output tokens.
    // All other agents use the gateway default (3 minutes). Per-turn today —
    // a tool loop's turns each get this budget individually, not the whole loop.
    const streamTimeoutMs = agentType === "frontend" ? 300_000 : undefined;

    // Fullstack builds emit ~10 files (frontend + backend + db) — double the
    // output budget so the response isn't truncated mid-file.
    const isFullstackBuild =
      task.description.startsWith("FULLSTACK BUILD:") ||
      task.description.startsWith("FULLSTACK AUTH BUILD:");
    const maxTokens = isFullstackBuild ? 32_000 : 16_000;

    // Thinking budget per agent type and task nature.
    // Haiku models (connection, deploy, monitor) ignore this — supportsThinking() returns false.
    // Edit-mode tasks (prefix "EXISTING PROJECT FILES:") are targeted — less planning needed.
    const isEditMode = task.description.startsWith("EXISTING PROJECT FILES:");
    const thinkingBudget =
      isEditMode                                               ? 1_500  // targeted edit
      : (isFullstackBuild || agentType === "frontend")        ? 8_000  // full new-build
      : agentType === "fix" || agentType === "backend"        ? 6_000  // crash/API analysis
      : agentType === "db"                                    ? 5_000  // schema design
      : 4_000;                                                         // security, planning, others

    const outputPath = join(WORKSPACE_BASE, ".sessions", sessionId, "agents", agentType, `${taskId}.md`);
    const startMs = Date.now();

    // ── Tool round-trip loop ────────────────────────────────────────────────
    // Without tools enabled, `wantsTools` below is always false (the model was
    // never offered any to request), so this executes exactly once — byte-for-
    // byte the same single dispatch behavior every existing call site had
    // before this loop existed.
    let fullContent = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const allToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const allMcpToolCalls: Array<{ id: string; name: string; serverName: string; isError: boolean }> = [];
    let requestedWriteAction = false;
    let loopCostUsd = 0;

    for (let round = 1; round <= MAX_TOOL_ROUNDTRIPS; round++) {
      const stream = this.gateway.stream(
        {
          model, messages, maxTokens, thinkingBudget,
          tools: enableTools ? [...TOOL_DEFINITIONS, ...writeProxyDefs] : undefined,
          ...(mcpDefs.length > 0 ? { mcpServers: mcpDefs, mcpToolsets } : {}),
        },
        streamTimeoutMs,
      );

      let streamResult: StreamResult;
      try {
        streamResult = await handleAgentStream(
          stream as unknown as AsyncGenerator<HandlerStreamChunk>,
          { sessionId, agentType, taskId, outputPath, wsServer: getWebSocketServer() },
        );
      } catch (err) {
        await this.tracker.fail(taskId, String(err)).catch(() => undefined);
        throw err;
      }

      fullContent += streamResult.content;
      totalInputTokens += streamResult.inputTokens;
      totalOutputTokens += streamResult.outputTokens;
      allToolCalls.push(...streamResult.toolCalls);
      allMcpToolCalls.push(...streamResult.mcpToolCalls);
      if (streamResult.toolCalls.some((tc) => tc.name === "request_write_action")) {
        requestedWriteAction = true;
      }

      // In-loop cost check — the outer cumulativeCostUsd checks in build.ts
      // only run BETWEEN dispatch() calls, so without this a runaway loop
      // inside one dispatch could spend past MAX_BUILD_COST_USD before any
      // outer checkpoint gets a chance to see it. This makes the round-trip
      // cap the primary spend bound during the loop, not just an anti-hang guard.
      if (costGuard) {
        loopCostUsd += this.tracker.computeUsage(model, streamResult.inputTokens, streamResult.outputTokens).costUsd;
        if (costGuard.cumulativeUsd + loopCostUsd >= costGuard.maxUsd) {
          logger.warn(
            { sessionId, agentType, round, loopCostUsd, cumulativeUsd: costGuard.cumulativeUsd, maxUsd: costGuard.maxUsd },
            "Tool loop: cost ceiling reached mid-loop — stopping, proceeding with whatever context was gathered",
          );
          break;
        }
      }

      const wantsTools = streamResult.stopReason === "tool_use" && streamResult.toolCalls.length > 0;
      if (!wantsTools) break; // model is done — this round's content is final

      if (round === MAX_TOOL_ROUNDTRIPS) {
        // Used the last allowed round and still wants more — stop instead of
        // executing/continuing, same "surface it, don't loop forever" pattern
        // every other bounded fix loop in this codebase already uses.
        logger.warn({ sessionId, agentType, round }, "Tool loop: max round-trips reached — proceeding with partial context");
        break;
      }

      // Replay the assistant's turn (text + the tool_use block(s) it made),
      // execute each tool, then supply the results as the next user turn.
      const assistantBlocks: MessageContentBlock[] = [];
      if (streamResult.content) assistantBlocks.push({ type: "text", text: streamResult.content });
      for (const tc of streamResult.toolCalls) {
        let input: unknown = {};
        try { input = JSON.parse(tc.arguments || "{}"); } catch { /* executeTool re-parses and reports the same error */ }
        assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      messages.push({ role: "assistant", content: assistantBlocks });

      const resultBlocks: MessageContentBlock[] = [];
      // Reset per-round: the fail-all-on-first-deny rule applies within a single
      // model response's tool list, not across rounds. A new round is a new model
      // turn that can issue fresh write requests if earlier ones were approved.
      const writeDenied = { value: false };
      for (const tc of streamResult.toolCalls) {
        const result = await executeTool(tc.name, tc.arguments, {
          contextFiles,
          sessionId,
          writeMcpRegistry: writeProxyRegistry,
          writeDenied,
          toolCallId: tc.id,
        }).catch(
          (err) => `Error: tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        try {
          getWebSocketServer().emitToRoom(sessionId, "build:tool_result", {
            tool: tc.name,
            result: result.startsWith("Error:") ? "error" : "success",
            sessionId,
          });
          // Dedicated signal for the generic "no proxy available" case.
          if (tc.name === "request_write_action") {
            getWebSocketServer().emitToRoom(sessionId, "build:write_action_declined", {
              message: result,
              sessionId,
            });
          }
        } catch {
          // WS server unavailable — non-fatal, matches the ws() helper's fallback in build.ts
        }
      }
      messages.push({ role: "user", content: resultBlocks });
    }

    // Persist the full multi-round transcript at this dispatch's canonical
    // path. handleAgentStream() already wrote each round's own text there
    // (each round overwrites the last), so without this the file on disk
    // would only reflect the final round instead of the full loop.
    await writeFile(outputPath, fullContent, "utf-8").catch((err) => {
      console.error("[dispatcher] Failed to persist full tool-loop transcript:", err);
    });

    const usage = this.tracker.computeUsage(model, totalInputTokens, totalOutputTokens);
    await this.tracker.complete(taskId, usage).catch((e) => {
      logger.warn({ err: e }, "Failed to record agent task completion");
    });

    // Real usage billing: deduct actualCostUsd × margin from the user's
    // balance now that the dispatch (and every tool round-trip in it) has
    // actually completed. Single hook point covers every dispatch() caller —
    // build.ts's 7 call sites and any future one — without each needing to
    // remember to deduct manually. No userId (e.g. internal/system dispatches)
    // means no billing to do.
    if (userId) {
      await deductUsage(userId, usage.costUsd, usageCategory);
    }

    return {
      taskId,
      modelUsed: model,
      tierUsed: tier,
      content: fullContent,
      reasoning: "",
      toolCalls: allToolCalls,
      mcpToolCalls: allMcpToolCalls,
      requestedWriteAction,
      outputPath,
      durationMs: Date.now() - startMs,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: usage.costUsd,
    };
  }

}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _dispatcher: AgentDispatcher | null = null;

export function getDispatcher(): AgentDispatcher {
  if (_dispatcher === null) {
    _dispatcher = new AgentDispatcher();
  }
  return _dispatcher;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
