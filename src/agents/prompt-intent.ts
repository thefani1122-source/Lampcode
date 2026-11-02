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
  "You are an intent classifier for an AI coding and developer workspace.\n" +
  "Decide whether a user's chat message is:\n" +
  "1. 'query': A conversational question, code review/explanation request, research, casual conversation, or an inspection of connected services/tools (e.g. asking to list or check GitHub repositories, branches, commits, PRs, Vercel deployments, domains, projects, Supabase database tables or general status).\n" +
  "2. 'build': An active request to create, generate, build, modify, edit, style, fix, delete, or write code/files for an app, or deploy it.\n\n" +
  "EXAMPLES OF 'query':\n" +
  "- 'checks my github repos kon kon si repos hain github pe'\n" +
  "- 'what repos do I have on github?'\n" +
  "- 'check vercel deployments is my site live'\n" +
  "- 'what does App.tsx do?'\n" +
  "- 'explain this code and find any bugs'\n" +
  "- 'how does OAuth work?'\n" +
  "- 'hi what can you do?'\n\n" +
  "EXAMPLES OF 'build':\n" +
  "- 'build me a modern fitness tracker app'\n" +
  "- 'change the button color to blue'\n" +
  "- 'fix the login form validation error'\n" +
  "- 'add a dark mode toggle to the navbar'\n" +
  "- 'deploy my app to vercel'\n\n" +
  'Return JSON only: {"intent": "query" | "build", "category": "service_check" | "code_question" | "research" | "general" | "build", "reason": "short explanation"}';

/**
 * Classify whether a prompt is a conversational query/inspection or an app build.
 * No regex keyword overrides are applied; the request goes directly to the model.
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
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) {
    return { type: "query", queryCategory: "general", reason: "empty prompt" };
  }

  // Direct model classification — semantic intent decided by LLM without regex keyword interference
  if (opts?.dispatcher && opts.sessionId && opts.userId && opts.projectId) {
    try {
      const result = await opts.dispatcher.dispatch({
        agentType: "acceptance",
        usageCategory: "build",
        provider: opts.provider ?? "modal",
        task: {
          description: `${INTENT_CLASSIFY_INSTRUCTION}\n\nUSER MESSAGE:\n${text}`,
          outputFormat: "json",
        },
        sessionId: opts.sessionId,
        userId: opts.userId,
        projectId: opts.projectId,
        enableTools: false,
        costGuard: { cumulativeUsd: 0, maxUsd: 0.05 },
      });

      const raw = result.finalContent || result.content || "";
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        if (parsed["intent"] === "query") {
          const cat = parsed["category"] || "general";
          return {
            type: "query",
            queryCategory: ["service_check", "code_question", "research", "general"].includes(String(cat))
              ? (cat as "service_check" | "code_question" | "research" | "general")
              : "general",
            reason: String(parsed["reason"] ?? "Classified as query by model"),
          };
        }
        if (parsed["intent"] === "build") {
          return { type: "build", reason: String(parsed["reason"] ?? "Classified as build by model") };
        }
      }
    } catch (err) {
      logger.warn({ err }, "[classifyPromptIntent] model classification failed, falling back to build");
    }
  }

  // Safe fallback if model dispatcher is unavailable (e.g. offline tests or network loss)
  return { type: "build", reason: "Default fallback build intent" };
}
