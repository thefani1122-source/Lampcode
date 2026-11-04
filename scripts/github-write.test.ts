import { GITHUB_WRITE_DEFS, buildGithubWriteRegistry, githubWriteHandler, githubMergeHandler } from "../src/agents/tools/github-writes.js";
import { TOOL_DEFINITIONS, AGENTIC_BUILD_TOOLS } from "../src/agents/tools.js";
import { REGISTRY } from "../src/agents/tools/registry.js";
import { narrateTool } from "../src/agents/tool-narration.js";
import { GITHUB_QUERY_ACTIONS, githubQueryHandler } from "../src/agents/tools/github-query.js";
import { TOOL_CAPABILITIES } from "../src/mcp/capabilities.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`ok ${name}`);
  else { failures++; console.log(`FAIL ${name}`); }
}

function ctxWithToken(): never {
  return { gitHubToken: "ghp_test" } as never;
}

// ── Definition and narration ────────────────────────────────────────────────
for (const name of ["github_write", "github_merge"]) {
  ok(`${name} is defined`, GITHUB_WRITE_DEFS.some((t) => t.name === name));
  ok(`${name} is narrated`, narrateTool(name).label.length > 0);
}

// Writes must NEVER be reachable without the approval gate: they are absent
// from the always-on tool lists and from the static handler registry.
const staticNames = new Set([...TOOL_DEFINITIONS, ...AGENTIC_BUILD_TOOLS].map((t) => t.name));
for (const name of GITHUB_WRITE_DEFS.map((t) => t.name)) {
  ok(`${name} is NOT in the static tool lists`, !staticNames.has(name));
  ok(`${name} is NOT in the static registry`, !REGISTRY.has(name));
}

// The registry exists only when a PAT is stored (fail closed).
ok("no token means no write tools offered", buildGithubWriteRegistry(undefined).size === 0);
const registry = buildGithubWriteRegistry("ghp_test");
ok("both write tools offered with a token", registry.size === 2);
ok("github_write is approval tier", registry.get("github_write")?.tier === "approval");
ok("github_merge is strong-approval", registry.get("github_merge")?.tier === "strong-approval");
ok("write metas carry a local executor", typeof registry.get("github_write")?.localExecute === "function");
ok("write metas declare the github server", registry.get("github_write")?.serverSlug === "github");
ok("merge metas declare the github server", registry.get("github_merge")?.serverSlug === "github");

// Validation paths speak before any network call is made.
const noRepo = await githubWriteHandler({ action: "create_issue", title: "Hi" }, ctxWithToken());
ok("github_write without a repo is refused", noRepo.includes("owner/repo"));
const noTitle = await githubWriteHandler({ action: "create_issue", repo: "o/r" }, ctxWithToken());
ok("create_issue without a title is refused", noTitle.includes("title"));
const noNumber = await githubWriteHandler({ action: "comment_on_issue", repo: "o/r" }, ctxWithToken());
ok("comment without an issue number is refused", noNumber.includes("issue_number"));
const noComment = await githubWriteHandler({ action: "comment_on_issue", repo: "o/r", issue_number: "3" }, ctxWithToken());
ok("comment without text is refused", noComment.includes("comment"));
const noBranch = await githubWriteHandler({ action: "create_branch", repo: "o/r" }, ctxWithToken());
ok("create_branch without a branch name is refused", noBranch.includes("branch"));
const noPrBase = await githubWriteHandler({ action: "create_pull_request", repo: "o/r", head: "feature" }, ctxWithToken());
ok("create_pull_request without a base branch is refused", noPrBase.includes("base"));
const unknown = await githubWriteHandler({ action: "delete_repo", repo: "o/r" }, ctxWithToken());
ok("unknown write actions are refused", unknown.includes("Unknown action"));
const noToken = await githubWriteHandler({ action: "create_issue", repo: "o/r", title: "x" }, {} as never);
ok("no token is refused", noToken.includes("not connected"));

const noPullNumber = await githubMergeHandler({ repo: "o/r" }, ctxWithToken());
ok("merge without a pull number is refused", noPullNumber.includes("pull_number"));
const badMethod = await githubMergeHandler({ repo: "o/r", pull_number: "1", merge_method: "force" }, ctxWithToken());
ok("merge with an unknown method is refused", badMethod.includes("merge_method"));
const mergeNoToken = await githubMergeHandler({ repo: "o/r", pull_number: "1" }, {} as never);
ok("merge without a token is refused", mergeNoToken.includes("not connected"));

// ── Reads ───────────────────────────────────────────────────────────────────
ok("github_query exposes the full read surface", GITHUB_QUERY_ACTIONS.length === 16);
const noTokenQuery = await githubQueryHandler({}, {} as never);
ok("github_query without a token speaks", noTokenQuery.includes("not connected") || noTokenQuery.includes("PAT"));
const missingRepo = await githubQueryHandler({ action: "get_issue" }, ctxWithToken());
ok("repo-scoped actions demand a repo", missingRepo.includes("repo"));
const missingNumber = await githubQueryHandler({ action: "get_issue", repo: "o/r" }, ctxWithToken());
ok("get_issue without a number is refused", missingNumber.includes("issue_number"));

// ── Capability map additions ────────────────────────────────────────────────
ok("github push_files maps to repo.write", TOOL_CAPABILITIES["github"]?.["push_files"] === "repo.write");
ok("github merge_pull_request maps to repo.write", TOOL_CAPABILITIES["github"]?.["merge_pull_request"] === "repo.write");

if (failures) process.exit(1);
console.log("\nAll GitHub write/read tool checks passed.");
