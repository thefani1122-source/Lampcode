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
  "Decide whether a user's chat message is an APP BUILD / CODE EDIT request OR a CONVERSATIONAL QUERY / RESEARCH / INSPECTION request.\n\n" +
  "Return 'query' if the user is:\n" +
  "- Asking to check or list their GitHub repositories, branches, commits, or PRs (e.g. 'checks my github repos', 'kon kon si repos hain')\n" +
  "- Asking to check Vercel deployments, domains, or projects (e.g. 'check vercel deployments', 'is my site live')\n" +
  "- Asking to inspect Supabase database tables or data\n" +
  "- Asking a question about existing code (e.g. 'what does App.tsx do?', 'explain this', 'why is this failing?', 'review this code')\n" +
  "- Asking for general advice, research, comparison, or documentation\n" +
  "- Casual greeting or question (e.g. 'hi', 'what can you do?')\n\n" +
  "Return 'build' if the user is:\n" +
  "- Asking to create, build, generate, or design a new app, page, or feature\n" +
  "- Asking to modify, edit, update, style, fix, delete, or add code/files\n" +
  "- Asking to deploy the app (e.g. 'deploy to vercel', 'put it live')\n\n" +
  'Return JSON only: {"intent": "query" | "build", "category": "service_check" | "code_question" | "research" | "general" | "build", "reason": "one short sentence"}';

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

  // 1. Fast deterministic build signals:
  // If the user explicitly asks to build, create, or code something
  const explicitBuildVerbs =
    /\b(build\s+(?:me\s+)?(?:a|an|the)|create\s+(?:a|an|the)|make\s+(?:a|an|the)|design\s+(?:a|an|the)|generate\s+(?:a|an|the)|implement\s+(?:a|an|the)|banao|add\s+(?:a|an|the|this|some)\b|change\s+(?:the|this|all)\b|update\s+(?:the|this)\b|style\s+(?:the|this)\b|fix\s+(?:the|this)\b|refactor\s+(?:the|this)\b|delete\s+(?:the|this)\b|remove\s+(?:the|this)\b|put\s+(?:a|an|this)\b|integrate\s+(?:a|an|the)\b)\b/i;

  const isExplicitBuild = explicitBuildVerbs.test(text);

  // 2. Fast deterministic query signals:
  // Service check: repos, deployments, databases, etc.
  const isServiceCheck =
    /\b(github|repo|repos|repository|repositories|vercel|deployments?|supabase|database|tables?|branches?|commits?|pull\s*requests?|prs?)\b/i.test(text) &&
    /\b(check|checks|list|show|view|find|what|which|kon\s*kon\s*si|kya\s+hai|kahan|status|inspect|fetch|get)\b/i.test(text);

  // Code inspection / explanation / review:
  const isCodeQuestion =
    /\b(explain|what\s+does|how\s+does|where\s+is|why\s+(?:is|does)|(?:review|audit|check|inspect)\s+(?:the\s+)?(?:code|project|files?)|find\s+bugs?|samjha\s*do|batao|kya\s+hai|kahan\s+hai)\b/i.test(text);

  // Research / comparison:
  const isResearch =
    /\b(what\s+is\s+the\s+difference|compare|search\s+for|research|how\s+does.*work|best\s+practices?|recommend)\b/i.test(text);

  // Casual greeting:
  const isGreeting =
    /^(hi|hello|hey|salam|assalam|kya\s+haal|who\s+are\s+you|help)\b/i.test(text) &&
    text.split(/\s+/).length <= 5;

  if (isServiceCheck && !isExplicitBuild) {
    return { type: "query", queryCategory: "service_check", reason: "User is asking to inspect connected services/repos" };
  }
  if (isCodeQuestion && !isExplicitBuild) {
    return { type: "query", queryCategory: "code_question", reason: "User is asking a question about the code or requesting an explanation/audit" };
  }
  if (isResearch && !isExplicitBuild) {
    return { type: "query", queryCategory: "research", reason: "User is asking for general information or research" };
  }
  if (isGreeting) {
    return { type: "query", queryCategory: "general", reason: "Casual greeting" };
  }

  // If clearly explicit build:
  if (isExplicitBuild && !isServiceCheck && !isCodeQuestion && !isResearch) {
    return { type: "build", reason: "Explicit build or code modification request" };
  }

  // 3. Ambiguous cases: use lightweight model classification if dispatcher available
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
        costGuard: { cumulativeUsd: 0, maxUsd: 0.05 },
      });

      const raw = result.finalContent || result.content;
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        if (parsed["intent"] === "query") {
          const cat = parsed["category"] || "general";
          return {
            type: "query",
            queryCategory: ["service_check", "code_question", "research", "general"].includes(String(cat))
              ? (cat as any)
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

  // Default fallback is build so standard app generation works
  return { type: "build", reason: "Default build intent" };
}
