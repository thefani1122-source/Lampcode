/** Regression coverage for semantic intent routing and query-mode isolation. */
import { readFileSync } from "node:fs";
import { classifyPromptIntent } from "../src/agents/prompt-intent.js";
import type { AgentDispatcher } from "../src/agents/dispatcher.js";
import { QUERY_MODE_READONLY_TOOL_NAMES } from "../src/agents/tool-disclosure.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
    return;
  }
  failures++;
  console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
}

const intentSource = readFileSync("src/agents/prompt-intent.ts", "utf8");
check("intent routing contains no deterministic keyword backstop", !intentSource.includes("deterministicQueryBackstop"), true);
check("intent router dispatches to the dedicated intent role", intentSource.includes('agentType: "intent"'), true);
check("intent model receives no tools", intentSource.includes("enableTools: false"), true);
check("intent model failure never defaults to a build", intentSource.includes('type: "query",\n    queryCategory: "general",\n    reason: "I could not reliably classify'), true);

// Query mode remains a server-enforced read-only capability set. The model
// chooses among the offered tools, but it cannot turn a question into writes.
const dispatcherSource = readFileSync("src/agents/dispatcher.ts", "utf8");
const disclosureSource = readFileSync("src/agents/tool-disclosure.ts", "utf8");
check("dispatcher delegates query filtering to ToolDisclosure", dispatcherSource.includes("ToolDisclosure.filterForTask("), true);
check("query allowlist is explicit and exported", disclosureSource.includes("QUERY_MODE_READONLY_TOOL_NAMES"), true);
for (const forbidden of ["write_files", "edit_file", "delete_file", "shell", "deploy_app", "vercel_write", "install_plugin_from_github", "manage_plugin"]) {
  check(`queryMode excludes ${forbidden}`, QUERY_MODE_READONLY_TOOL_NAMES.has(forbidden), false);
}
for (const required of ["list_files", "read_file", "read_project_file", "search_code", "review_code", "web_search", "github_query", "vercel_query"]) {
  check(`queryMode includes ${required}`, QUERY_MODE_READONLY_TOOL_NAMES.has(required), true);
}

function mockDispatcher(response: Record<string, unknown>): AgentDispatcher {
  return {
    dispatch: async (options: Record<string, unknown>) => {
      check("classifier uses its dedicated intent persona", options["agentType"], "intent");
      check("classifier model call does not enable tools", options["enableTools"] ?? false, false);
      const task = options["task"] as Record<string, unknown>;
      check("classifier receives the original message verbatim", String(task["description"]).includes("USER MESSAGE (verbatim):\n"), true);
      return { finalContent: JSON.stringify(response), content: JSON.stringify(response) } as never;
    },
  } as unknown as AgentDispatcher;
}

const ctx = { sessionId: "s", userId: "u", projectId: "p" };
const service = await classifyPromptIntent("checks my github repos kon kon si repos hain github pe", {
  ...ctx,
  dispatcher: mockDispatcher({ intent: "query", category: "service_check", reason: "service inspection" }),
});
check("Roman Urdu GitHub question follows model query decision", service.type, "query");

const review = await classifyPromptIntent("review this code and find any bugs", {
  ...ctx,
  dispatcher: mockDispatcher({ intent: "query", category: "code_question", reason: "review request" }),
});
check("code review follows model query decision", review.type, "query");

const snippet = await classifyPromptIntent("show me a small TypeScript example of a debounce function", {
  ...ctx,
  dispatcher: mockDispatcher({ intent: "query", category: "code_question", reason: "code example request" }),
});
check("code examples remain a query rather than a project build", snippet.type, "query");

const build = await classifyPromptIntent("build me a calorie tracker", {
  ...ctx,
  dispatcher: mockDispatcher({ intent: "build", category: "build", reason: "app creation" }),
});
check("app creation follows model build decision", build.type, "build");

const empty = await classifyPromptIntent("   ");
check("empty prompt has safe query classification", empty.type, "query");

const unavailable = await classifyPromptIntent("build me a calorie tracker");
check("missing classifier capability takes the non-mutating route", unavailable.type, "query");

let attempts = 0;
const throwingDispatcher = {
  dispatch: async () => {
    attempts++;
    throw new Error("classifier down");
  },
} as unknown as AgentDispatcher;
const afterFailure = await classifyPromptIntent("fix the login form validation error", {
  ...ctx,
  dispatcher: throwingDispatcher,
});
check("failed classification retries twice", attempts, 2);
check("failed classification does not start a build by default", afterFailure.type, "query");

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll semantic intent routing and query-mode isolation tests passed.");

// ── End-to-End Route Lifecycle Guarantees for Query vs Build ───────────────
const buildSrc = readFileSync("src/server/routes/build.ts", "utf-8");
const queryMatch = buildSrc.match(/if\s*\(promptIntent\.type === "query"\)\s*\{([\s\S]*?)return;\s*\}/);
check("build route has an explicit query execution branch that returns early", Boolean(queryMatch), true);

const queryBody = queryMatch?.[1] ?? "";
check("query branch does NOT create a preview sandbox", queryBody.includes("createPreviewSandbox("), false);
check("query branch does NOT write project files", queryBody.includes("writeFilesToSandbox("), false);
check("query branch does NOT invoke repair or fix loops", queryBody.includes("fixPreviewErrors(") || queryBody.includes("findDeadCodeHandler("), false);
check("query branch does NOT invoke E2B runtime backend verification", queryBody.includes("e2bCanRunNonNodeBackend"), false);
check("query branch completes with previewUrl set to null", queryBody.includes("previewUrl: null"), true);
check("query branch completes with files set to empty object", queryBody.includes("files: {}"), true);
check("query branch completes with totalFiles 0", queryBody.includes("totalFiles: 0"), true);
check("query branch updates session status to success", queryBody.includes('status: "success"'), true);
check("query branch resets project status to live", queryBody.includes('status: "live"'), true);
check("query message is the exact original user prompt", buildSrc.includes("const queryTaskDescription = prompt;"), true);
check("query message no longer duplicates a hand-written tool catalogue", !buildSrc.includes("AVAILABLE INSPECTION TOOLS"), true);
