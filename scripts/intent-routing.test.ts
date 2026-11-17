/** Model-led assistant handoff and query-mode capability isolation. */
import { readFileSync } from "node:fs";
import {
  parseProjectBuildHandoff,
  REQUEST_PROJECT_BUILD_TOOL_NAME,
} from "../src/agents/build-handoff.js";
import { QUERY_MODE_READONLY_TOOL_NAMES } from "../src/agents/tool-disclosure.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
  } else {
    failures++;
    console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
  }
}

const valid = parseProjectBuildHandoff(JSON.stringify({ reason: "The user explicitly asked to fix the login flow." }));
check("valid model handoff is accepted", valid.ok, true);
check("valid handoff reason is preserved", valid.ok ? valid.reason : "", "The user explicitly asked to fix the login flow.");
check("malformed JSON is rejected", parseProjectBuildHandoff("{").ok, false);
check("missing reason is rejected", parseProjectBuildHandoff(JSON.stringify({})).ok, false);
check("empty reason is rejected", parseProjectBuildHandoff(JSON.stringify({ reason: "   " })).ok, false);
check("oversized reason is rejected", parseProjectBuildHandoff(JSON.stringify({ reason: "x".repeat(601) })).ok, false);
check("handoff tool has a stable name", REQUEST_PROJECT_BUILD_TOOL_NAME, "request_project_build");

// Query mode receives read-only project/service tools plus ONE control signal.
// That signal only transfers control; it cannot mutate project files or services.
check("query mode includes the non-writing workspace handoff signal", QUERY_MODE_READONLY_TOOL_NAMES.has("request_project_build"), true);
for (const forbidden of [
  "write_files",
  "edit_file",
  "delete_file",
  "checkpoint",
  "revert",
  "deploy_app",
  "manage_plugin",
  "install_plugin_from_github",
]) {
  check(`query mode excludes direct mutation capability: ${forbidden}`, QUERY_MODE_READONLY_TOOL_NAMES.has(forbidden), false);
}
for (const allowed of [
  "list_files",
  "read_file",
  "read_project_file",
  "search_code",
  "review_code",
  "web_search",
  "github_query",
  "vercel_query",
  "load_skill",
]) {
  check(`query mode includes safe capability: ${allowed}`, QUERY_MODE_READONLY_TOOL_NAMES.has(allowed), true);
}

const dispatcherSource = readFileSync("src/agents/dispatcher.ts", "utf8");
check("dispatcher supplies a separate workspace handoff tool in query mode", dispatcherSource.includes("...QUERY_HANDOFF_TOOLS"));
check("dispatcher validates the handoff instead of executing it as a normal tool", dispatcherSource.includes("parseProjectBuildHandoff(tc.arguments)"));
check("dispatcher only accepts the handoff from query mode", dispatcherSource.includes("options.queryMode && tc.name === REQUEST_PROJECT_BUILD_TOOL_NAME"));
check("dispatch result reports requestedBuild", dispatcherSource.includes("requestedBuild,"));
check("dispatcher returns control after a valid handoff", dispatcherSource.includes("if (requestedBuild) break;"));

const toolsSource = readFileSync("src/agents/tools.ts", "utf8");
check("handoff is declared separately from ordinary tools", toolsSource.includes("export const QUERY_HANDOFF_TOOLS"));
check("handoff description says it does not modify files or services", toolsSource.includes("does not modify files or external services itself"));

const promptSource = readFileSync("src/agents/prompt-builder.ts", "utf8");
check("query assistant can give code snippets in chat", promptSource.includes("provide snippets or complete examples in chat"));
check("query assistant knows when to request workspace execution", promptSource.includes("call `request_project_build`"));
check("query assistant does not ban all code output", !promptSource.includes("never write app code"));
check("dedicated intent persona has been removed", !promptSource.includes("You classify the user's latest message"));
check("dedicated intent model role has been removed from the model catalogue", !readFileSync("src/agents/model-gateway.ts", "utf8").includes("intent:"));

const routeSource = readFileSync("src/server/routes/build.ts", "utf8");
check("build route no longer calls a separate intent classifier", !routeSource.includes("classifyPromptIntent"));
check("every request first reaches the conversational assistant", routeSource.includes('agentType: "query"'));
check("assistant receives the original prompt as its task text", routeSource.includes("description: prompt,"));
check("a normal answer completes without activating the workspace", routeSource.includes("if (!queryDispatchResult.requestedBuild)"));
check("only a model-requested handoff continues into build setup", routeSource.includes("if (!queryDispatchResult.requestedBuild)"));
check("build handoff keeps the original request for later build dispatch", routeSource.includes("userPrompt: prompt,"));

if (failures) {
  console.error(`\n${failures} model-led handoff test(s) failed.`);
  process.exit(1);
}
console.log("\nAll model-led assistant handoff and query-mode isolation tests passed.");
