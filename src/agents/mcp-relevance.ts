import type { ActiveMcpServer } from "../server/routes/integrations.js";
import type { ToolDefinition } from "./model-gateway.js";

/**
 * Which connected MCP servers this build actually needs, and a ceiling on how
 * many of their tools ride along.
 *
 * MEASURED 2026-10-17, build cbd7099d. A plain "build me a full-stack app"
 * request was sent **283 tool definitions every round** — 21 GitHub writes, 95
 * Vercel writes, 28 GitHub reads, 130 Vercel reads — with the fourteen tools
 * that actually build an app (`write_files`, `edit_file`, `check_page` …) last
 * in the list. On round 5 the gateway returned nothing at all:
 *
 *     [stream] loop done: totalChunks=2 contentChunks=0 fullContentLen=0
 *
 * which CLAUDE.md names as ZERO events parsed. One second later the build died
 * with "The AI did not produce a valid src/App.tsx". The model never got to
 * write the one file the build required.
 *
 * This is new. Only GitHub was connected until 2026-10-16, when Vercel was
 * added — and Vercel alone brings ~225 tools. The cost shows up twice: in the
 * context that crowds out the work, and in the input tokens of every round.
 *
 * CLAUDE.md already held the principle, applied to the wrong half: Firecrawl
 * and Exa are deliberately kept off this gateway because "each costs a
 * discovery round trip plus its full tool list in every round's context". That
 * reasoning was never extended to the servers a user connects.
 *
 * WHAT THIS IS NOT. `build.ts` carries a comment saying the old upfront keyword
 * gate was removed so "the model decides that itself once these are attached".
 * That gate decided whether to FETCH, and fetching is a cheap local query. This
 * decides what to ATTACH to a dispatch, which is neither cheap nor local, and
 * it only ever removes servers that nothing in the request points at. A build
 * that mentions deploying, a repo, a push or a provider by name keeps
 * everything it mentioned.
 *
 * The safety net that makes this comfortable: `deploy_app` is a NATIVE tool
 * using the Vercel token directly, not MCP. Dropping the Vercel MCP server from
 * an unrelated build removes nothing the build could have used.
 */

/** Words that mean a category of server is genuinely in play. */
const CATEGORY_HINTS: Record<string, RegExp> = {
  deploy:
    /\b(deploy|deploys|deploying|deployment|redeploy|rollback|host|hosting|go\s*live|production|ship\s+it|publish)\b/i,
  repo: /\b(github|repo|repos|repository|git|push|commit|commits|branch|pull\s*request|prs?)\b/i,
  automation: /\b(n8n|zapier|make\.com|automation|automate|workflow|webhook|cron)\b/i,
  cms: /\b(wordpress|shopify|cms|storefront|e-?commerce)\b/i,
  design: /\b(figma|design\s*file|mockup)\b/i,
  tracker: /\b(linear|jira|sentry|issue\s*tracker|bug\s*report)\b/i,
  payment: /\b(stripe|payment|payments|pay|checkout|billing|invoice|subscription|subscriptions|pricing|charge)\b/i,
  content: /\b(notion|wiki|doc|docs|documentation|note|notes|knowledge)\b/i,
  database: /\b(supabase|postgres|sql|db|database|table|tables|schema|migration|mongo|mongodb)\b/i,
};

/** Which category each known server belongs to. Unknown slugs match by name. */
const SERVER_CATEGORY: Record<string, keyof typeof CATEGORY_HINTS> = {
  vercel: "deploy",
  netlify: "deploy",
  railway: "deploy",
  cloudflare: "deploy",
  render: "deploy",
  github: "repo",
  gitlab: "repo",
  n8n: "automation",
  zapier: "automation",
  make: "automation",
  wordpress: "cms",
  shopify: "cms",
  figma: "design",
  linear: "tracker",
  sentry: "tracker",
  jira: "tracker",
  stripe: "payment",
  notion: "content",
  supabase: "database",
  mongodb: "database",
};

/**
 * Ceiling on MCP tool definitions per dispatch, across every kept server.
 *
 * Even one relevant server can be enormous — Vercel's ~225 would re-create the
 * failure above on its own, on exactly the deploy build that asked for it. The
 * cap keeps the tools whose NAMES the request points at first, then fills, and
 * reports what it left out rather than silently shortening the list.
 */
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
    const named = new RegExp(`\\b${slug.replace(/[^a-z0-9]/g, "\\$&")}\\b`, "i").test(prompt);
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
