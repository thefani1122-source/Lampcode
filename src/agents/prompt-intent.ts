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
  "1. 'query': A conversational question, code review/explanation request, research, casual conversation, or an inspection of connected services/tools (e.g. asking to list or check GitHub repositories, branches, commits, PRs, issues, Vercel deployments, domains, projects, Supabase database tables or general status). IMPORTANT: a request to LIST, SHOW, FETCH or CHECK data from the user's own connected account is ALWAYS 'query', even when phrased as an imperative command or including a repository/org name ('list karo', 'dikhao', 'show me', 'fetch'). Listing data is never a build.\n" +
  "2. 'build': An active request to create, generate, build, modify, edit, style, fix, delete, or write code/files for an app, or deploy it.\n\n" +
  "EXAMPLES OF 'query':\n" +
  "- 'checks my github repos kon kon si repos hain github pe'\n" +
  "- 'what repos do I have on github?'\n" +
  "- 'thefani1122-source/Lampcode ke open issues list karo'\n" +
  "- 'list all open issues in my repository'\n" +
  "- 'meri vercel deployments dikhao'\n" +
  "- 'show my Shopify products'\n" +
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
 * Model-first: every request is classified by a small model call with no tools,
 * and no keyword router ever runs before it. The only deterministic code is a
 * narrow backstop that fires AFTER the model failed twice — see
 * deterministicQueryBackstop for why it exists and how narrow it is kept.
 */
/**
 * Last-resort safety net, used ONLY after the classification model failed or
 * returned nothing parsable twice. Measured 2026-11-04: every classifier
 * outage silently defaulted these prompts to "build", where the generation
 * model reached for the web scrapers (Firecrawl/Exa), failed their calls, and
 * ended on "The AI did not produce a valid src/App.tsx". A build dispatch is
 * the most expensive and most destructive default there is, so the outage
 * fallback now sends clear connected-data listing prompts to the cheap query
 * path instead.
 *
 * Deliberately narrow: both a connected-service word AND a listing verb must
 * appear, and any code-writing or app-change verb disqualifies the prompt.
 * Real builds ("build me a GitHub issues dashboard") never match — "build"
 * itself is in the disqualifying list.
 */
const CONNECTED_SERVICE_PATTERN =
  /\b(github|repo\b|repos\b|repositor|issues?\b|pull requests?\b|prs?\b|commits?\b|branches?\b|workflows?\b|vercel|deployments?\b|shopify|wordpress|twilio|sendgrid|mailchimp|supabase)\b/i;
const LISTING_VERB_PATTERN =
  /\b(list|show|check|fetch|open|my|mer[ie]|kons?[ei]|kon|kaun|dikhao|dikha|batao|batay?|kitn[ei]|status|how many|all)\b/i;
const CODE_CHANGE_VERB_PATTERN =
  /\b(build|create|make|add|implement|fix|generate|write|banao|bana|delete|remove|update|refactor|deploy|redesign|rebuild)\b/i;

function deterministicQueryBackstop(prompt: string): PromptIntent | null {
  const text = prompt.trim();
  if (!text) return null;
  if (CODE_CHANGE_VERB_PATTERN.test(text)) return null;
  if (CONNECTED_SERVICE_PATTERN.test(text) && LISTING_VERB_PATTERN.test(text)) {
    return {
      type: "query",
      queryCategory: "service_check",
      reason: "Classifier unavailable; deterministic backstop matched a connected-data listing request",
    };
  }
  return null;
}

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
    // Two attempts: one transient provider failure should never route a
    // prompt; two in a row is evidence the classifier is down and it is safe
    // to fall through to the deterministic backstop below.
    for (let attempt = 1; attempt <= 2; attempt++) {
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
        logger.warn({ err, attempt }, "[classifyPromptIntent] model classification attempt failed");
      }
    }
  }

  // Classifier unavailable or unparsable after retries: the backstop returns
  // connected-data listing prompts to the cheap query path, and everything
  // else keeps the historical build default (offline tests, network loss).
  const backstop = deterministicQueryBackstop(text);
  if (backstop) {
    logger.warn(
      { prompt: text.slice(0, 120) },
      "[classifyPromptIntent] classifier unavailable — deterministic backstop routed this prompt to the query path",
    );
    return backstop;
  }

  return { type: "build", reason: "Default fallback build intent" };
}
