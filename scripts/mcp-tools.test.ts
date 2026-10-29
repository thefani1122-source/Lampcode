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

import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildReadToolDefinitions,
  buildWriteProxyDefinitions,
  writeActionByName,
  type ClassifiedTool,
} from "../src/agents/mcp-tool-classifier.js";
import type { ActiveMcpServer } from "../src/server/routes/integrations.js";

// Read-like prefixes must not smuggle compound mutation tools into query mode.
for (const name of [
  "get_or_create_deployment",
  "get_repository_and_create_branch",
  "list_projects_and_deploy",
  "search_and_update_issue",
]) {
  check(`compound write name is not read-only: ${name}`, writeActionByName(name), true);
}
for (const name of ["get_deployments", "list_projects", "search_issues", "get_file_contents"]) {
  check(`read name remains eligible: ${name}`, writeActionByName(name), false);
}

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

// An unannotated tool whose name does not look like a read goes behind the
// approval gate — NOT into a void.
//
// This case used to assert the opposite, and that is how it stayed broken for
// two months while the owner reported it. MCP annotations are optional per the
// spec and many servers omit them, so `name-pattern-no-match` is the ordinary
// case for a write, not an exotic one. Denied as a read and skipped by the
// proxy, such a tool appeared NOWHERE and the model could not see it existed.
//
// Measured 2026-10-16: a build asked to create a repo, push, and deploy spent
// nine minutes calling create_repository four times — GitHub annotates that
// one — and never pushed, because `push_files` had silently vanished.
//
// Fail-closed is kept. An unclassified tool is not automatically callable; it
// is callable with the user's approval. Vanishing is not a safer default than
// asking, it is the same denial with the reason hidden from everyone.
check(
  "an ambiguous tool is offered behind approval, not hidden",
  [
    read.toolDefs.some((d) => d.name === "github__merge_pull_request"),
    write.toolDefs.some((d) => d.name === "github__merge_pull_request"),
  ],
  [false, true],
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
    // H2/H3: the tier the call will be treated as, and the capability the map
    // recognised. `null` here is honest — TOOL_CAPABILITIES has never heard of
    // list_issues — and it is exactly the case that must NOT change the tier of
    // a tool the classifier independently established as read-only.
    tier: "read",
    capability: null,
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


// ── the habit-tracker failure, pinned ────────────────────────────────────────
// 2026-10-16. "create a repo, push the code, deploy to vercel" → nine minutes,
// create_repository called four times, nothing pushed, output.md written.
// GitHub's MCP annotates create_repository as destructive, so it was offered.
// push_files is neither read-verbed nor (on an unannotated server) marked, so
// it was offered NOWHERE. The model was not refusing to push — it could not
// see any way to.
{
  const servers = [{ slug: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authToken: "t" }];
  const report = [
    t("github", "create_repository", false, "annotation-destructive"),
    t("github", "push_files", false, "name-pattern-no-match"),
    t("github", "create_or_update_file", false, "name-pattern-no-match"),
    t("github", "get_file_contents", true, "name-pattern-match"),
  ];
  const r = buildReadToolDefinitions(report, servers as never);
  const w = buildWriteProxyDefinitions(report, servers as never);
  const names = new Set(w.toolDefs.map((d) => d.name));

  ok("push_files is reachable behind approval", names.has("github__push_files"));
  ok("create_or_update_file is reachable too", names.has("github__create_or_update_file"));
  ok("create_repository still is", names.has("github__create_repository"));
  ok("a read tool stays on the read path", r.toolDefs.some((d) => d.name.endsWith("get_file_contents")));
  ok("and is NOT duplicated into the write proxy", !names.has("github__get_file_contents"));
  ok("every write-proxied tool is registered for dispatch", w.toolDefs.every((d) => w.registry.has(d.name)));
}

// ── H1: which protocol the installed SDK actually negotiates ─────────────────
// Answered 2026-10-17 by reading the installed SDK, not the changelog.
//
// package.json pins "^1.29.0", which resolves to 1.32.1 today. The client sends
// LATEST_PROTOCOL_VERSION on initialize and then accepts whatever the server
// replies with, PROVIDED it is in SUPPORTED_PROTOCOL_VERSIONS; anything else is
// a hard throw ("Server's protocol version is not supported"). After that it
// hands the negotiated version to the transport, which sends it as the
// `mcp-protocol-version` header on every later request.
//
// Statelessness needs nothing from us: the transport sends `mcp-session-id`
// only when a server handed one back, so a stateless server simply never gets
// the header. Our own usage is connect → listTools → callTool → close, which is
// valid either way.
//
// WHY THIS IS A CASE AND NOT A NOTE. The `^` means the floor is pinned and the
// protocol is not. A minor bump can move LATEST under us, and the failure it
// produces is a server-side rejection during discovery — which this codebase
// swallows into `failures` and reports as "server unavailable this build". That
// is correct fail-closed behaviour and it is also indistinguishable from a
// flaky server, so the cause would never be found from the logs. This case
// turns that silent drift into a red test on the machine that upgrades.
{
  ok("the SDK offers the protocol we recorded", LATEST_PROTOCOL_VERSION === "2025-11-25");
  ok("it still accepts the 2025-06-18 spec", SUPPORTED_PROTOCOL_VERSIONS.includes("2025-06-18"));
  ok("and the stateful 2025-03-26 one", SUPPORTED_PROTOCOL_VERSIONS.includes("2025-03-26"));
  ok(
    "the negotiated default is not newer than what servers support",
    SUPPORTED_PROTOCOL_VERSIONS.includes(DEFAULT_NEGOTIATED_PROTOCOL_VERSION),
  );
}

// Read source text instead of importing the registry: its handlers transitively
// load e2b-service, which must not be initialized by an offline test process.
const toolDefinitionsSource = readFileSync(new URL("../src/agents/tools.ts", import.meta.url), "utf8");
const toolRegistrySource = readFileSync(new URL("../src/agents/tools/registry.ts", import.meta.url), "utf8");
const parsedDefinitions = ts.createSourceFile("tools.ts", toolDefinitionsSource, ts.ScriptTarget.Latest, true);
const parsedRegistry = ts.createSourceFile("registry.ts", toolRegistrySource, ts.ScriptTarget.Latest, true);
const getArrayNames = (sourceFile: ts.SourceFile, variableName: string): string[] => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== variableName ||
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(declaration.initializer)
      ) continue;
      return declaration.initializer.elements.flatMap((element) => {
        if (!ts.isObjectLiteralExpression(element)) return [];
        const name = element.properties.find((property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text === "name",
        );
        return name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)
          ? [name.initializer.text]
          : [];
      });
    }
  }
  return [];
};
const staticToolNames = [
  ...getArrayNames(parsedDefinitions, "TOOL_DEFINITIONS"),
  ...getArrayNames(parsedDefinitions, "AGENTIC_BUILD_TOOLS"),
];
const registryDeclaration = parsedRegistry.statements
  .flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
  .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "REGISTRY");
const registryInitializer = registryDeclaration?.initializer;
const registryEntries =
  registryInitializer && ts.isNewExpression(registryInitializer)
    ? registryInitializer.arguments?.[0]
    : undefined;
const registryNames =
  registryEntries &&
  ts.isArrayLiteralExpression(registryEntries)
    ? registryEntries.elements.flatMap((entry) =>
        ts.isArrayLiteralExpression(entry) &&
        entry.elements[0] !== undefined &&
        ts.isStringLiteral(entry.elements[0])
          ? [entry.elements[0].text]
          : [],
      )
    : [];
const sortedNames = (names: string[]) => [...names].sort();
check(
  "every static tool has a registry entry and the registry has no extras",
  {
    missing: sortedNames(staticToolNames.filter((name) => !registryNames.includes(name))),
    extra: sortedNames(registryNames.filter((name) => !staticToolNames.includes(name))),
  },
  { missing: [], extra: [] },
);
check("static tool registry covers all definitions", registryNames.length, staticToolNames.length);
check(
  "runtime MCP write/read proxy paths are documented outside the static registry",
  toolRegistrySource.includes("write-proxy") && toolRegistrySource.includes("read-only MCP"),
  true,
);


console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
