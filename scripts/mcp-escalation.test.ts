/**
 * Cases for the H2/H3 integration — the real classification path, not just the
 * pure `tierFor()`. Run by `npm test`.
 *
 * THE INVARIANT, and the only one that matters here: capability metadata may
 * make a call STRICTER and may never make it safer. The MCP classifier decides
 * read vs write from evidence about the tool — the server's own `readOnlyHint`,
 * or a name matching a read verb. The capability map in `src/mcp/capabilities.ts`
 * covers four tools. A capability of `null` is therefore a fact about the MAP,
 * not about the tool, and must not drag a tool out of a build or into an
 * approval prompt on its own.
 *
 * `tierFor(null) === "approval"` stays fail-closed in its own contract — see
 * tiers.test.ts — and the integration takes the strongest of the two verdicts.
 * These cases pin both halves of that, because the tempting simplification
 * (apply tierFor everywhere) would put a prompt in front of every `get_*` on
 * every connected service.
 */

import { readFileSync } from "node:fs";
import { buildReadToolDefinitions, buildWriteProxyDefinitions, type ClassifiedTool } from "../src/agents/mcp-tool-classifier.js";
import { strongestTier, needsApproval, tierFor } from "../src/mcp/tiers.js";
import type { ActiveMcpServer } from "../src/server/routes/integrations.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

const servers = [
  { slug: "github", url: "https://api.githubcopilot.com/mcp/", authToken: "tok-gh" },
  { slug: "vercel", url: "https://mcp.vercel.com", authToken: "tok-v" },
] as unknown as ActiveMcpServer[];

const tool = (toolName: string, reason: ClassifiedTool["reason"], serverSlug = "github"): ClassifiedTool => ({
  serverSlug,
  toolName,
  allowed: reason === "annotation-read-only" || reason === "name-pattern-match",
  reason,
});

// ── Ordering ────────────────────────────────────────────────────────────────

check("read is the weakest", strongestTier("read", "approval") === "approval");
check("strong-approval wins over approval", strongestTier("approval", "strong-approval") === "strong-approval");
check("strong-approval wins in either order", strongestTier("strong-approval", "read") === "strong-approval");
check("two reads stay read", strongestTier("read", "read") === "read");
check("sandbox does not outrank approval", strongestTier("sandbox", "approval") === "approval");
check("only the two approval tiers need an answer", needsApproval("approval") && needsApproval("strong-approval") && !needsApproval("read") && !needsApproval("sandbox"));

// ── An unmapped read tool is left exactly where the classifier put it ───────

{
  const read = buildReadToolDefinitions([tool("list_issues", "annotation-read-only")], servers);
  check("an unmapped read tool is still offered", read.toolDefs.some((t) => t.name === "github__list_issues"));
  check("it is not escalated by a null capability", read.escalated.length === 0);
  check("its tier is read", read.registry.get("github__list_issues")?.tier === "read");
  check("and the null capability is recorded honestly", read.registry.get("github__list_issues")?.capability === null);
  check("tierFor on its own would have gated it", tierFor(null, "list_issues") === "approval");
}

{
  // The mapped read case: capability agrees, nothing changes.
  const read = buildReadToolDefinitions([tool("get_file_contents", "annotation-read-only")], servers);
  check("a mapped read capability keeps the tool on the read path", read.toolDefs.some((t) => t.name === "github__get_file_contents"));
  check("with its capability recorded", read.registry.get("github__get_file_contents")?.capability === "repo.read");
}

// ── Escalation: a destructive tool does not stay on the auto-run path ───────

for (const name of ["delete_branch", "drop_table", "destroy_env", "force_push"]) {
  const read = buildReadToolDefinitions([tool(name, "name-pattern-match")], servers);
  check(`${name} leaves the read path`, !read.toolDefs.some((t) => t.name === `github__${name}`));
  check(`${name} is reported as escalated, not silently dropped`, read.escalated.some((e) => e.startsWith(`github__${name}:`)));
  check(`${name} is escalated to strong-approval`, read.escalated.some((e) => e.endsWith(":strong-approval")));
}

// ── The write path: approval is the floor, strong-approval the ceiling ──────

{
  const write = buildWriteProxyDefinitions(
    [tool("create_issue", "annotation-destructive"), tool("push_files", "name-pattern-no-match")],
    servers,
  );
  check("an annotated write stays available behind approval", write.toolDefs.some((t) => t.name === "github__create_issue"));
  check("an ambiguous tool is still offered behind approval", write.toolDefs.some((t) => t.name === "github__push_files"));
  check("an unmapped write sits at approval, not below it", write.registry.get("github__push_files")?.tier === "approval");
  check("its description still asks for approval", write.toolDefs.find((t) => t.name === "github__push_files")?.description.includes("Requires user approval") === true);
}

{
  // deploy.rollback is the mapped irreversible case; a rollback-shaped name is
  // the unmapped one. Both must reach strong-approval.
  const write = buildWriteProxyDefinitions([tool("rollback_deployment", "annotation-destructive", "vercel")], servers);
  check("a rollback-shaped write reaches strong-approval", write.registry.get("vercel__rollback_deployment")?.tier === "strong-approval");
  check(
    "and the model is told it may be irreversible",
    write.toolDefs.find((t) => t.name === "vercel__rollback_deployment")?.description.includes("POSSIBLY IRREVERSIBLE") === true,
  );
}

{
  // Discovery failure stays fail-closed: not read, not write, not escalated.
  const failed = [tool("mystery", "discovery-failed")];
  check("a discovery failure is offered nowhere", buildReadToolDefinitions(failed, servers).toolDefs.length === 0 && buildWriteProxyDefinitions(failed, servers).toolDefs.length === 0);
}

// ── Nothing is filtered out merely for being unmapped ──────────────────────

{
  const report: ClassifiedTool[] = [
    tool("list_issues", "annotation-read-only"),
    tool("search_code", "name-pattern-match"),
    tool("push_files", "name-pattern-no-match"),
    tool("create_issue", "annotation-destructive"),
  ];
  const read = buildReadToolDefinitions(report, servers);
  const write = buildWriteProxyDefinitions(report, servers);
  check(
    "every classified tool is still reachable somewhere",
    read.toolDefs.length + write.toolDefs.length === report.length,
  );
  const names = new Set([...read.toolDefs, ...write.toolDefs].map((t) => t.name));
  check("read and write sets remain disjoint", names.size === report.length);
}

// ── The approval path carries the tier, and claims no UI it does not have ──

{
  const tools = readFileSync(new URL("../src/agents/tools.ts", import.meta.url), "utf8");
  check("the approval request carries the tier", tools.includes("tier: meta.tier"));
  check("and a human-readable note with it", tools.includes("tierNote: describeTier(meta.tier)"));
  check("the stronger case is logged distinctly", tools.includes("POSSIBLY IRREVERSIBLE action"));
  check(
    "and the code says plainly that the UI has no separate prompt yet",
    tools.includes("frontend change that has") && tools.includes("Inventing a second prompt"),
  );
  check(
    "the existing deny-on-timeout and deny-without-socket behaviour is untouched",
    tools.includes("resolveApproval(toolCallId, sessionId, false)") && tools.includes("Action denied: the write action was not approved by the user."),
  );
}

console.log(`\n${checks} MCP escalation checks passed`);
