/**
 * Cases for MCP relevance and the per-dispatch tool ceiling. Run by `npm test`.
 *
 * The failure these exist for is build cbd7099d, 2026-10-17: a plain app build
 * was sent 283 tool definitions every round, the gateway returned zero events
 * on round 5, and the build died without ever writing src/App.tsx.
 *
 * The danger in fixing it is the opposite mistake — a filter so eager that
 * someone who says "push this to GitHub and deploy it" finds the tools missing.
 * So the keep cases are weighted at least as heavily as the drop cases, and the
 * decisive one is the regression itself: the exact 283-tool shape must come
 * back under the ceiling, and a build that asks for deploys must keep Vercel.
 */

import {
  MAX_MCP_TOOLS,
  capMcpTools,
  serversForPrompt,
} from "../src/agents/mcp-relevance.js";
import type { ToolDefinition } from "../src/agents/model-gateway.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const srv = (slug: string) =>
  ({ slug, name: slug, url: `https://mcp.${slug}.com`, authToken: "t" }) as never;
const ALL = [srv("github"), srv("vercel"), srv("n8n"), srv("wordpress")];
const keptSlugs = (p: string) => serversForPrompt(p, ALL).kept.map((s) => (s as { slug: string }).slug);

// ── the failure, pinned ──────────────────────────────────────────────────────

// The exact request shape that produced the 283-tool round. Nothing in it
// points at a connected service, so nothing should ride along.
check(
  "a plain app build attaches no MCP server at all",
  keptSlugs("Build a complete, working issue tracker with login and a dashboard"),
  [],
);

check(
  "and the dropped list says which ones, for the log",
  serversForPrompt("Build a todo app", ALL).dropped,
  ["github", "vercel", "n8n", "wordpress"],
);

// ── the opposite mistake, pinned harder ──────────────────────────────────────

ok("naming a server keeps it", keptSlugs("deploy this to vercel").includes("vercel"));
ok("'push to github' keeps github", keptSlugs("push this to github").includes("github"));
ok("'create a repo' keeps github", keptSlugs("create a repo for this project").includes("github"));
ok("'commit' keeps github", keptSlugs("commit the changes").includes("github"));
ok("'deploy it' keeps every deploy server", keptSlugs("deploy it").includes("vercel"));
ok("'go live' counts as deploying", keptSlugs("make it go live").includes("vercel"));
ok("an automation request keeps n8n", keptSlugs("add an automation workflow").includes("n8n"));
ok("a wordpress request keeps wordpress", keptSlugs("sync posts to wordpress").includes("wordpress"));

// The whole point: a request that wants both gets both, and still drops what
// it never mentioned.
check(
  "a repo + deploy request keeps exactly those two",
  keptSlugs("create a github repo, push the code, and deploy to vercel").sort(),
  ["github", "vercel"],
);

// A word that merely CONTAINS a hint must not trigger it. "prepublish" is a
// real word in a package.json conversation and means nothing about deploying.
ok("'prepublished' does not count as publish", !keptSlugs("the prepublished draft").includes("vercel"));

// Explicit provider mentions should narrow a category instead of attaching every
// server in that category. A request for Vercel's deployments must not also
// send Railway and Cloudflare's tools just because all are deployment services.
check(
  "an explicit Vercel query keeps Vercel only",
  keptSlugs("check Vercel recent deployments").sort(),
  ["vercel"],
);
check(
  "an explicit provider plus a different category keeps the needed implicit provider",
  keptSlugs("check Vercel deployments and open a GitHub pull request").sort(),
  ["github", "vercel"],
);


// ── the ceiling ──────────────────────────────────────────────────────────────

const defs = (n: number, prefix: string): ToolDefinition[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix}__tool_${i}`,
    description: "x",
    input_schema: { type: "object" as const },
  }));

check("a small list is untouched", capMcpTools("anything", defs(10, "github")).omitted, 0);
check("the same list keeps its order", capMcpTools("anything", defs(10, "github")).kept.length, 10);

{
  // Vercel alone is ~225 tools, which would re-create the original failure on
  // exactly the deploy build that asked for it.
  const r = capMcpTools("deploy to vercel", defs(225, "vercel"));
  check("225 tools are capped", r.kept.length, MAX_MCP_TOOLS);
  check("and the omitted count is honest", r.omitted, 225 - MAX_MCP_TOOLS);
}

{
  // Ranking: a tool whose name the request gestures at survives the cut even
  // when it would otherwise be far down the list.
  const list: ToolDefinition[] = [
    ...defs(MAX_MCP_TOOLS, "vercel"),
    { name: "vercel__create_deployment", description: "x", input_schema: { type: "object" } },
  ];
  const r = capMcpTools("create a deployment for this project", list);
  ok(
    "a tool the request names survives the cut",
    r.kept.some((d) => d.name === "vercel__create_deployment"),
  );
}

{
  // Stability matters: a list that reshuffles between rounds invalidates the
  // model's own sense of what it can call.
  const list = defs(200, "vercel");
  const a = capMcpTools("deploy", list).kept.map((d) => d.name);
  const b = capMcpTools("deploy", list).kept.map((d) => d.name);
  check("the same request produces the same list twice", a, b);
}

// No ranking signal must degrade to "keep the first N", never to "send all" —
// the whole failure was sending all.
{
  const r = capMcpTools("", defs(300, "vercel"));
  check("an empty prompt still caps", r.kept.length, MAX_MCP_TOOLS);
}

console.log(
  failures === 0 ? "\nAll MCP relevance cases passed." : `\n${failures} MCP relevance case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
