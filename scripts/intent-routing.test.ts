/** Regression coverage for model-first intent routing and query-mode isolation. */
import { readFileSync } from "node:fs";
import { classifyPromptIntent } from "../src/agents/prompt-intent.js";
import type { AgentDispatcher } from "../src/agents/dispatcher.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
    return;
  }
  failures++;
  console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
}

// Ensure every request reaches the intent model before semantic classification.
const intentSource = readFileSync("src/agents/prompt-intent.ts", "utf8");
check("intent router has no keyword-regex decision variables", /const\s+is(?:ExplicitBuild|ServiceCheck|CodeQuestion|Research|Greeting)\s*=\s*\//.test(intentSource), false);
check("intent router dispatches to the model", intentSource.includes("opts.dispatcher.dispatch({"), true);
check("intent model is explicitly given no tools", intentSource.includes("enableTools: false"), true);

// Query mode must never expose file mutation, shell, or deployment tools.
const dispatcherSource = readFileSync("src/agents/dispatcher.ts", "utf8");
const queryModeBlock = dispatcherSource.match(/options\.queryMode\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[\.\.\.TOOL_DEFINITIONS/);
check("dispatcher retains isolated queryMode tool list", Boolean(queryModeBlock), true);
const queryBlock = queryModeBlock?.[1] ?? "";
for (const forbidden of ["write_files", "edit_file", "delete_file", "shell", "deploy_app"]) {
  check(`queryMode excludes ${forbidden}`, queryBlock.includes(`"${forbidden}"`), false);
}
for (const required of ["list_files", "read_file", "search_code", "review_code", "web_search", "github_query", "vercel_query"]) {
  check(`queryMode includes ${required}`, queryBlock.includes(`"${required}"`), true);
}

function mockDispatcher(response: Record<string, unknown>): AgentDispatcher {
  return {
    dispatch: async (options: Record<string, unknown>) => {
      // The classification call must not include tools or credentials that enable side effects.
      check("classifier model call does not enable tools", options["enableTools"] ?? false, false);
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

const build = await classifyPromptIntent("build me a calorie tracker", {
  ...ctx,
  dispatcher: mockDispatcher({ intent: "build", category: "build", reason: "app creation" }),
});
check("app creation follows model build decision", build.type, "build");

const empty = await classifyPromptIntent("   ");
check("empty prompt has safe query classification", empty.type, "query");

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll model-first intent routing and query-mode isolation tests passed.");
