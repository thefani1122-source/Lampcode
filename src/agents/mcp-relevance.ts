import type { ActiveMcpServer } from "../server/routes/integrations.js";
import type { ToolDefinition } from "./model-gateway.js";

/**
 * Every connected MCP server is discovered for every assistant turn.
 *
 * Server selection by keyword used to hide capabilities before the model had
 * a chance to understand the task. The model now chooses among discovered tool
 * definitions. Security classification remains a separate permission boundary,
 * and capMcpTools keeps the provider request within a bounded tool budget.
 */
export function serversForPrompt(
  _prompt: string,
  servers: ActiveMcpServer[],
): { kept: ActiveMcpServer[]; dropped: string[] } {
  return { kept: [...servers], dropped: [] };
}

export const MAX_MCP_TOOLS = 80;

function wordsOf(prompt: string): string[] {
  return (prompt.toLowerCase().match(/[a-z_]{3,}/g) ?? []).slice(0, 400);
}

/**
 * Keep a connected server only when the request points at it: by name, or by a
 * word that means its category is in play. Returns the dropped slugs so the
 * decision can be logged — a server that silently vanishes is the failure mode
 * this whole area keeps producing.
 */
export function serversForPrompt(
  prompt: string,
  servers: ActiveMcpServer[],
): { kept: ActiveMcpServer[]; dropped: string[] } {
  const kept: ActiveMcpServer[] = [];
  const dropped: string[] = [];

  for (const s of servers) {
    const slug = s.slug.toLowerCase();
    // Named outright — always keep, whatever the category rules say. Someone
    // who types "vercel" means Vercel even in a sentence about nothing else.
    const isStitch = slug === "google-stitch" || slug === "stitch" || slug === "googlestitch";
    const named = isStitch
      ? /\b(stitch|stich|google\s*stitch|google\s*stich)\b/i.test(prompt)
      : new RegExp(`\\b${slug.replace(/[^a-z0-9]/g, "\\$&")}\\b`, "i").test(prompt);
    const category = SERVER_CATEGORY[slug];
    const byCategory = category ? CATEGORY_HINTS[category]!.test(prompt) : false;
    if (named || byCategory) kept.push(s);
    else dropped.push(s.slug);
  }

  return { kept, dropped };
}

/**
 * Trim MCP tool definitions to `MAX_MCP_TOOLS`, preferring the ones the request
 * actually gestures at.
 *
 * Native build tools are NOT passed through here — they are never the thing to
 * drop, and keeping them out of the ranking is what guarantees that.
 */
export function capMcpTools(
  prompt: string,
  defs: ToolDefinition[],
  max: number = MAX_MCP_TOOLS,
): { kept: ToolDefinition[]; omitted: number } {
  if (defs.length <= max) return { kept: defs, omitted: 0 };

  const words = new Set(wordsOf(prompt));
  const scored = defs.map((d, i) => {
    const parts = d.name.toLowerCase().split(/[^a-z]+/).filter((p) => p.length >= 3);
    const hits = parts.reduce((n, p) => n + (words.has(p) ? 1 : 0), 0);
    // `i` keeps the order stable among equal scores, so the same request
    // produces the same tool list twice — a list that reshuffles between
    // rounds would invalidate the model's own cache of what it can call.
    return { d, hits, i };
  });
  scored.sort((a, b) => b.hits - a.hits || a.i - b.i);

  return { kept: scored.slice(0, max).map((s) => s.d), omitted: defs.length - max };
}
