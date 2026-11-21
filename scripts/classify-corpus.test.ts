import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUILD_INTENT_INSTRUCTION,
  buildClassificationDescription,
  parseClassification,
} from "../src/agents/build-classifier.js";
import { EVAL_TASKS } from "./eval/tasks.js";

let checks = 0;
function ok(name: string, condition: boolean): void {
  checks++;
  if (!condition) {
    console.error("✘ " + name);
    throw new Error(name);
  }
  console.log("✔ " + name);
}

const accepted = {
  buildType: "fullstack",
  framework: "nextjs",
  backendRuntime: "node",
  database: "none",
  persistence: "none",
  needsAuth: false,
  requiredTools: ["filesystem", "shell", "browser"],
  reason: "The requested Route Handler needs a server but no application database.",
};

console.log("\n— model decision schema —");
ok("a model-selected Next.js server without database is valid", parseClassification(JSON.stringify(accepted))?.database === "none");
ok("legacy boolean-only classifier output is no longer accepted", parseClassification('{"needsServer":true,"needsSignIn":false,"why":"legacy"}') === null);
ok("an invalid framework is rejected instead of silently mapped to React", parseClassification(JSON.stringify({ ...accepted, framework: "nuxt" })) === null);
ok("an unsupported tool cannot become an authorized capability", !((parseClassification(JSON.stringify({ ...accepted, requiredTools: ["filesystem", "root-shell"] }))?.requiredTools ?? []).includes("root-shell")));

console.log("\n— architecture prompt rules —");
ok("new projects default to Next.js App Router", /Next\.js App Router is LampCode's DEFAULT/.test(BUILD_INTENT_INSTRUCTION));
ok("React/Vite requires an explicit or project-specific reason", /Choose React \+ Vite only when/.test(BUILD_INTENT_INSTRUCTION));
ok("frontend-only does not imply or require a server", /frontend.*means the requested product can work without an application backend/s.test(BUILD_INTENT_INSTRUCTION));
ok("a server can exist without a database", /database.*none.*when a real application database is not needed/s.test(BUILD_INTENT_INSTRUCTION));
ok("browser-local storage is distinguished from shared database persistence", /browser-local/.test(BUILD_INTENT_INSTRUCTION));
ok("required tool capabilities are model-selected recommendations, not grants", /NOT an authorization grant/.test(BUILD_INTENT_INSTRUCTION));

console.log("\n— original prompt delivery —");
const corpus = EVAL_TASKS as Array<{ id: string; prompt: string }>;
ok("the historical evaluation corpus still contains 21 tasks", corpus.length === 21);
for (const task of corpus) {
  const modelInput = buildClassificationDescription(task.prompt);
  const encodedStart = modelInput.lastIndexOf("\\n") + 2;
  const encoded = modelInput.slice(encodedStart);
  ok(`model architecture input JSON-encodes the exact original prompt: ${task.id}`, encoded === JSON.stringify(task.prompt));
  ok(`model architecture input keeps the original request after the architecture contract: ${task.id}`, modelInput.endsWith(JSON.stringify(task.prompt)));
}

console.log("\n— classifier implementation has no prompt-keyword decision layer —");
const source = readFileSync(new URL("../src/agents/build-classifier.ts", import.meta.url), "utf8");
ok("the old server keyword regex is removed", !source.includes("SERVER_THING_RE"));
ok("the old client keyword regex is removed", !source.includes("CLIENT_ONLY_RE"));
ok("the old auth keyword regex is removed", !source.includes("AUTH_SYSTEM_RE"));
ok("the old readSignals decision layer is removed", !source.includes("readSignals("));
ok("the old heuristic decide() fallback is removed", !source.includes("function decide("));
ok("architecture is requested from the planning model", source.includes('agentType: "planning"') && source.includes("dispatcher.dispatch"));
ok("model failure does not fall back to regex or a guessed framework", source.includes("no build architecture was guessed") && source.includes("No framework, backend or database was guessed"));
ok("a second bounded call can repair invalid model JSON", source.includes("attempt < 2"));

console.log(`\n${checks} model-owned build architecture checks passed.`);
