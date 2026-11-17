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
    // Provider tool names commonly use `server__verb_object`; underscores
    // are separators here, not part of one token, otherwise "create deployment"
    // never matches "vercel__create_deployment".
    const nameParts = d.name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 3);
    const descriptionParts = wordsOf(d.description);
    const nameHits = nameParts.reduce((n, p) => n + (words.has(p) ? 1 : 0), 0);
    const descriptionHits = descriptionParts.reduce((n, p) => n + (words.has(p) ? 1 : 0), 0);
    // Tool descriptions often explain the capability more accurately than an
    // opaque provider-specific name. Prefer name matches, but use the
    // server-authored (credential-redacted) description as a second signal.
    const score = nameHits * 4 + descriptionHits;
    // `i` keeps the order stable among equal scores, so the same request
    // produces the same tool list twice — a list that reshuffles between
    // rounds would invalidate the model's own cache of what it can call.
    return { d, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  return { kept: scored.slice(0, max).map((s) => s.d), omitted: defs.length - max };
}
