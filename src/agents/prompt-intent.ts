import { logger } from "../server/logger.js";
import type { AgentDispatcher } from "./dispatcher.js";

export type PromptIntent =
  | {
      type: "query";
      queryCategory: "service_check" | "code_question" | "research" | "general";
      reason: string;
    }
  | {
      type: "build";
      reason: string;
    };

export const INTENT_CLASSIFY_INSTRUCTION =
  "Classify the user's latest message for the LampCode assistant runtime.\n" +
  "Return exactly one JSON object: {\"intent\":\"query\"|\"build\",\"category\":\"service_check\"|\"code_question\"|\"research\"|\"general\"|\"build\",\"reason\":\"short explanation\"}.\n" +
  "Use query for conversation, explanations, technical questions, code examples, research, code review/inspection, and read-only connected-service requests.\n" +
  "Use build only when the user asks LampCode to create, modify, fix, delete or deploy project code/files, or to perform a requested external write action.\n" +
  "Explaining how to fix something is query; actually fixing it is build. Finding/reporting bugs without changing files is query; repairing them is build.\n" +
  "When intent is genuinely unclear, choose query and explain the ambiguity. Do not invent requirements or add scope.";

/**
 * Semantic intent classification. This is deliberately a dedicated model role:
 * acceptance extracts product criteria and must not be reused for routing.
 * There is no regex/keyword fallback that rewrites or reinterprets user text.
 *
 * If the classifier is unavailable, choose the non-mutating query path and
 * report the limitation. A failed router must never silently start a build.
 */
export async function classifyPromptIntent(
  prompt: string,
  opts?: {
    dispatcher?: AgentDispatcher;
    sessionId?: string;
    userId?: string;
    projectId?: string;
    provider?: "anthropic" | "modal";
  },
): Promise<PromptIntent> {
  if (!prompt.trim()) {
    return { type: "query", queryCategory: "general", reason: "empty prompt" };
  }

  if (!opts?.dispatcher || !opts.sessionId || !opts.userId || !opts.projectId) {
    return {
      type: "query",
      queryCategory: "general",
      reason: "intent model is unavailable; using the non-mutating path",
    };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await opts.dispatcher.dispatch({
        agentType: "intent",
        usageCategory: "build",
        provider: opts.provider ?? "modal",
        task: {
          description: "Classify the original user request according to the intent schema in your system instructions. Do not change or expand its scope.",
          outputFormat: "json",
        },
        sessionId: opts.sessionId,
        userId: opts.userId,
        projectId: opts.projectId,
        userPrompt: prompt,
        enableTools: false,
        costGuard: { cumulativeUsd: 0, maxUsd: 0.05 },
      });

      const raw = result.finalContent || result.content || "";
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) {
        throw new Error("Intent model returned no JSON object");
      }

      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      if (parsed["intent"] === "query") {
        const category = String(parsed["category"] ?? "general");
        return {
          type: "query",
          queryCategory: ["service_check", "code_question", "research", "general"].includes(category)
            ? category as "service_check" | "code_question" | "research" | "general"
            : "general",
          reason: String(parsed["reason"] ?? "Classified as query by model"),
        };
      }
      if (parsed["intent"] === "build") {
        return { type: "build", reason: String(parsed["reason"] ?? "Classified as build by model") };
      }
      throw new Error("Intent model returned an unsupported intent");
    } catch (err) {
      logger.warn({ err, attempt }, "[classifyPromptIntent] intent model attempt failed");
    }
  }

  logger.error(
    { sessionId: opts.sessionId, promptLength: prompt.length },
    "[classifyPromptIntent] intent model unavailable; refusing to start a build by fallback",
  );
  return {
    type: "query",
    queryCategory: "general",
    reason: "I could not reliably classify this request, so I did not start a project build. Please retry or clarify the requested action.",
  };
}
