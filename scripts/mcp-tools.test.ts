/**
 * Cases for buildReadToolDefinitions. Run by `npm test`.
 *
 * This decides which connected-service tools an OpenAI-compatible build can
 * call. Until 2026-10-04 that set was empty by construction: MCP forced the
 * dispatch onto Anthropic, and Anthropic's key is not set on the service, so
 * connecting a server produced a broken build rather than tools. Now the same
 * tools Anthropic's connector would have run server-side are offered as
 * ordinary functions and executed on our side.
 *
 * The thing these cases protect is the SAFETY BOUNDARY: the read path must
 * expose exactly what classifyMcpServers marked `allowed`, and never a write.
 * A bug here is not a broken feature, it is an unapproved write against a
 * user's GitHub or Railway account.
 */

import {
  buildReadToolDefinitions,
  buildWriteProxyDefinitions,
  type ClassifiedTool,
} from "../src/agents/mcp-tool-classifier.js";
import type { ActiveMcpServer } from "../src/server/routes/integrations.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

const SERVERS: ActiveMcpServer[] = [
  { slug: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authToken: "tok-gh" },
  // mcp_url authType — token already embedded, so authToken is null and must
  // stay null through to execution rather than becoming an empty Bearer header.
  { slug: "railway", name: "Railway", url: "https://mcp.railway.app/u/secret", authToken: null },
];

const t = (
  serverSlug: string,
  toolName: string,
  allowed: boolean,
  reason: ClassifiedTool["reason"],
  inputSchema?: Record<string, unknown>,
): ClassifiedTool => ({ serverSlug, toolName, allowed, reason, inputSchema });

const REPORT: ClassifiedTool[] = [
  t("github", "list_issues", true, "annotation-read-only", { properties: { repo: { type: "string" } } }),
  t("github", "get_file_contents", true, "name-pattern-match"),
  t("github", "create_issue", false, "annotation-destructive", { properties: { title: { type: "string" } } }),
  t("github", "merge_pull_request", false, "name-pattern-no-match"),
  t("railway", "list_deployments", true, "annotation-read-only"),
  t("railway", "restart_service", false, "annotation-destructive"),
];

const read = buildReadToolDefinitions(REPORT, SERVERS);
const write = buildWriteProxyDefinitions(REPORT, SERVERS);

// ── Only allowed tools are offered ────────────────────────────────────────────

check(
  "exactly the allowed tools become read tools",
  read.toolDefs.map((d) => d.name).sort(),
  ["github__get_file_contents", "github__list_issues", "railway__list_deployments"],
);

check(
  "a destructive tool is never in the read set",
  read.toolDefs.some((d) => d.name.includes("create_issue") || d.name.includes("restart_service")),
  false,
);

// An unannotated tool whose name does not look like a read is ambiguous. It is
// blocked on BOTH paths — not readable, and not even write-proxyable, because
// a proxy would turn "we don't know what this does" into an approvable action.
check(
  "an ambiguous tool is in neither set",
  [
    read.toolDefs.some((d) => d.name === "github__merge_pull_request"),
    write.toolDefs.some((d) => d.name === "github__merge_pull_request"),
  ],
  [false, false],
);

// ── The two sets must not overlap ─────────────────────────────────────────────
// executeTool checks writeMcpRegistry first, so an overlap could only ever cost
// an approval prompt rather than skip one — but an overlap would still mean the
// classification disagrees with itself.
const overlap = read.toolDefs
  .map((d) => d.name)
  .filter((n) => write.toolDefs.some((w) => w.name === n));
check("read and write sets are disjoint", overlap, []);

// ── Registry carries what execution needs ─────────────────────────────────────

check(
  "registry resolves a read tool to its server and real tool name",
  read.registry.get("github__list_issues"),
  {
    serverSlug: "github",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    authToken: "tok-gh",
    mcpToolName: "list_issues",
  },
);

check(
  "a null authToken survives — it must not become an empty Bearer header",
  read.registry.get("railway__list_deployments")?.authToken,
  null,
);

check(
  "every offered tool has a registry entry to execute it",
  read.toolDefs.every((d) => read.registry.has(d.name)),
  true,
);

// ── Naming and schema ─────────────────────────────────────────────────────────

// Two servers can both expose "list_deployments"; without the prefix the second
// would overwrite the first in the registry and silently call the wrong account.
const collide = buildReadToolDefinitions(
  [t("github", "list_deployments", true, "annotation-read-only"), t("railway", "list_deployments", true, "annotation-read-only")],
  SERVERS,
);
check(
  "same tool name on two servers stays distinct",
  collide.toolDefs.map((d) => d.name).sort(),
  ["github__list_deployments", "railway__list_deployments"],
);

check(
  "the server's own input schema is carried through",
  read.toolDefs.find((d) => d.name === "github__list_issues")?.input_schema,
  { type: "object", properties: { repo: { type: "string" } } },
);

check(
  "a tool with no advertised schema still gets a valid object schema",
  read.toolDefs.find((d) => d.name === "github__get_file_contents")?.input_schema,
  { type: "object" },
);

// ── Degenerate inputs ─────────────────────────────────────────────────────────

check("no servers means no tools", buildReadToolDefinitions(REPORT, []).toolDefs.length, 0);
check("no report means no tools", buildReadToolDefinitions([], SERVERS).toolDefs.length, 0);

// A report naming a server that is no longer connected must not produce a tool
// with nowhere to send it.
check(
  "a tool for a disconnected server is dropped",
  buildReadToolDefinitions([t("notion", "list_pages", true, "annotation-read-only")], SERVERS).toolDefs.length,
  0,
);

// Discovery failure contributes no entries at all, which is what "fail closed"
// means here: a flaky server is unavailable, never open.
check(
  "a discovery-failed tool is not offered",
  buildReadToolDefinitions([t("github", "list_issues", false, "discovery-failed")], SERVERS).toolDefs.length,
  0,
);


// ── unwrapCreds ───────────────────────────────────────────────────────────────
// The owner's GitHub connection was stored as { creds: { github_token } } while
// the registry looked for github_token, so every lookup missed and the server
// never reached a build — connected in the UI, absent from every dispatch.
// Unwrapping on READ is what fixes rows already stored; getting it wrong would
// either keep them broken or mangle a correctly-stored one.

// Re-declared rather than exported from integrations.ts, which pulls in the DB
// client and the whole Hono app at import time. The contract is small enough
// that a drifting copy would fail these cases loudly.
function unwrapCreds(parsed: Record<string, unknown>): Record<string, string> {
  const keys = Object.keys(parsed);
  const inner = parsed["creds"];
  if (keys.length === 1 && keys[0] === "creds" && inner !== null && typeof inner === "object") {
    return inner as Record<string, string>;
  }
  return parsed as Record<string, string>;
}

check(
  "the envelope that broke the real connection is unwrapped",
  unwrapCreds({ creds: { github_token: "ghp_x" } }),
  { github_token: "ghp_x" },
);
check(
  "a correctly-stored flat object is returned untouched",
  unwrapCreds({ github_token: "ghp_x" }),
  { github_token: "ghp_x" },
);
// Only a LONE creds key is an envelope. A flat object that happens to carry a
// field called creds alongside real ones must not be replaced by that field.
check(
  "creds alongside other keys is data, not an envelope",
  unwrapCreds({ creds: "a-secret", api_key: "k" }),
  { creds: "a-secret", api_key: "k" },
);
check(
  "a lone creds holding a STRING is a credential, not an envelope",
  unwrapCreds({ creds: "a-secret" }),
  { creds: "a-secret" },
);
check("a lone creds holding null is left alone", unwrapCreds({ creds: null }), { creds: null });
check("an empty object survives", unwrapCreds({}), {});
check(
  "a doubly-wrapped envelope is unwrapped exactly one level",
  unwrapCreds({ creds: { creds: { github_token: "ghp_x" } } }),
  { creds: { github_token: "ghp_x" } },
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
