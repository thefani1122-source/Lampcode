/**
 * Model-owned build architecture contract.
 *
 * These tests validate the model-output schema and the trusted metadata path.
 * They deliberately do not call the live model: the build-intent prompt is
 * exercised separately in staging with real prompts.
 */
import assert from "node:assert/strict";
import {
  BUILD_INTENT_INSTRUCTION,
  BuildClassificationError,
  buildClassificationDescription,
  classifyBuild,
  parseClassification,
} from "../src/agents/build-classifier.js";
import { PromptBuilder } from "../src/agents/prompt-builder.js";
import { detectFullstackFramework } from "../src/agents/framework-selection.js";
import { canReuseSandboxForFramework } from "../src/preview/framework-compat.js";
import {
  detectDatabase,
  inferPromptBuildType,
  loadRelevantSkillsForPrompt,
  selectedBackendRuntime,
  selectedFullstackFramework,
} from "../src/agents/prompt-builder.js";

function decision(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    buildType: "frontend",
    framework: "nextjs",
    backendRuntime: "none",
    database: "none",
    persistence: "browser-local",
    needsAuth: false,
    requiredTools: ["filesystem", "shell", "browser"],
    reason: "A browser-local application does not need a separate server.",
    ...overrides,
  };
}

function expectValue(name: string, got: unknown, want: unknown): void {
  assert.deepEqual(got, want, name);
  console.log("✔ " + name);
}

function valid(raw: Record<string, unknown>) {
  const parsed = parseClassification(JSON.stringify(raw));
  assert.ok(parsed, "expected a valid model architecture decision");
  return parsed;
}

console.log("\n— model output validation —");

const nextFrontend = valid(decision());
expectValue("Next.js frontend-only decision is preserved", nextFrontend.framework, "nextjs");
expectValue("Next.js frontend-only decision has no backend", nextFrontend.backendRuntime, "none");
expectValue("local browser persistence is distinct from a database", nextFrontend.persistence, "browser-local");
expectValue("model tool needs are retained for the agent", nextFrontend.requiredTools, ["filesystem", "shell", "browser"]);

const nextFullstackNoDb = valid(decision({
  buildType: "fullstack",
  backendRuntime: "node",
  persistence: "none",
  requiredTools: ["filesystem", "shell", "browser", "package-install"],
  reason: "Next.js Route Handlers provide the requested API without a database.",
}));
expectValue("Next.js Route Handlers can be full-stack without Supabase", nextFullstackNoDb.database, "none");
expectValue("Next.js server APIs use its Node runtime", nextFullstackNoDb.backendRuntime, "node");

const reactFrontend = valid(decision({
  framework: "react",
  persistence: "browser-local",
  reason: "The requested Vite SPA is local to one browser and needs no server.",
}));
expectValue("React/Vite frontend can be selected by the model", reactFrontend.framework, "react");

const reactHonoSupabase = valid(decision({
  buildType: "fullstack",
  framework: "react",
  backendRuntime: "node",
  database: "supabase",
  persistence: "supabase",
  requiredTools: ["filesystem", "shell", "package-install", "mcp"],
  reason: "Shared cross-device records require a server and a real database.",
}));
expectValue("React/Hono full-stack with Supabase is supported", reactHonoSupabase.database, "supabase");

const fastApiMongo = valid(decision({
  buildType: "fullstack",
  framework: "react",
  backendRuntime: "python",
  database: "mongodb",
  persistence: "mongodb",
  reason: "The requested Python API uses MongoDB for durable shared records.",
}));
expectValue("React/Vite can use the Python backend when the model selects it", fastApiMongo.backendRuntime, "python");
expectValue("MongoDB remains separate from Supabase", fastApiMongo.database, "mongodb");

expectValue("unknown tool names are discarded, not granted", parseClassification(JSON.stringify(decision({
  requiredTools: ["filesystem", "sudo", "delete-account", "browser"],
})))?.requiredTools, ["filesystem", "browser"]);
expectValue("legacy needsServer classifier output is rejected", parseClassification('{"needsServer":true,"needsSignIn":false,"why":"legacy"}'), null);
expectValue("malformed JSON is rejected", parseClassification('{"buildType":'), null);
expectValue("empty model response is rejected", parseClassification(""), null);
expectValue("Next.js with Python backend is rejected", parseClassification(JSON.stringify(decision({
  buildType: "fullstack",
  backendRuntime: "python",
  persistence: "none",
  reason: "This combination is unsupported by the current Next runtime.",
}))), null);
expectValue("frontend-only with Supabase is rejected", parseClassification(JSON.stringify(decision({
  database: "supabase",
  persistence: "supabase",
  reason: "Frontend projects cannot directly own a database connection.",
}))), null);
expectValue("full-stack with no backend runtime is rejected", parseClassification(JSON.stringify(decision({
  buildType: "fullstack",
  persistence: "none",
  reason: "A full-stack build needs a server runtime.",
}))), null);
expectValue("Supabase cannot be paired with browser-local persistence", parseClassification(JSON.stringify(decision({
  buildType: "fullstack",
  backendRuntime: "node",
  database: "supabase",
  persistence: "browser-local",
  reason: "The database and persistence choices conflict.",
}))), null);

console.log("\n— model invocation and original prompt preservation —");
assert.ok(BUILD_INTENT_INSTRUCTION.includes("LAMPCode_BUILD_INTENT_DECISION_V1"));
assert.ok(BUILD_INTENT_INSTRUCTION.includes("Next.js App Router is LampCode's DEFAULT"));
assert.ok(BUILD_INTENT_INSTRUCTION.includes("Do not choose fullstack just because a server is fashionable"));
assert.ok(BUILD_INTENT_INSTRUCTION.includes("requiredTools"));
const original = "Build a full-stack health dashboard. Include the phrase Supabase only as an excluded option.";
const modelInput = buildClassificationDescription(original);
expectValue("model receives the exact original user request", modelInput.includes(original), true);
expectValue("original prompt is passed as a JSON-encoded data string", modelInput.includes(JSON.stringify(original)), true);
await assert.rejects(
  classifyBuild(original),
  (error: unknown) => error instanceof BuildClassificationError,
);
console.log("✔ missing architecture dispatcher fails closed without guessing");
const architecturePrompt = await new PromptBuilder().build(
  "planning",
  { description: modelInput, outputFormat: "json" },
  { projectId: "classifier-planning-contract", userId: "classifier-planning-contract", mode: "fast", prompt: original },
);
expectValue("architecture planning prompt advertises its dedicated decision mode",
  architecturePrompt.systemPrompt.includes("BUILD-INTENT DECISION MODE"), true);
expectValue("architecture planning is not biased by the default Next.js implementation skill",
  architecturePrompt.systemPrompt.includes("## Skill: nextjs-production"), false);
expectValue("architecture planning does not receive Vite/Hono implementation skills",
  architecturePrompt.systemPrompt.includes("## Skill: fullstack-hono"), false);


console.log("\n— metadata, not keyword matching, controls prompt/runtime selection —");
expectValue("new projects default to Next.js without reading prompt vocabulary", detectFullstackFramework("Build a React dashboard with Vite"), "nextjs");
expectValue("React is selected by a trusted framework marker", selectedFullstackFramework("Build a Next app.\nLAMPCode_SELECTED_FRAMEWORK: react"), "react");
expectValue("Next.js is selected by a trusted framework marker", detectFullstackFramework("Build using React.\nLAMPCode_SELECTED_FRAMEWORK: nextjs"), "nextjs");
expectValue("TanStack remains readable as an explicit trusted marker", detectFullstackFramework("LAMPCode_SELECTED_FRAMEWORK: tanstack"), "tanstack");
expectValue("database words in raw user text do not select Supabase", detectDatabase("Use Supabase if you need a database"), "none");
expectValue("database words in raw user text do not select MongoDB", detectDatabase("Use MongoDB for storage"), "none");
expectValue("database marker selects Supabase", detectDatabase("LAMPCode_SELECTED_DATABASE: supabase"), "supabase");
expectValue("database marker selects MongoDB", detectDatabase("LAMPCode_SELECTED_DATABASE: mongodb"), "mongodb");
expectValue("backend runtime comes from model metadata", selectedBackendRuntime("LAMPCode_SELECTED_BACKEND_RUNTIME: python"), "python");
expectValue("no database keyword means no inferred full-stack prompt", inferPromptBuildType("frontend", "Build an API with Supabase"), "frontend");
expectValue("trusted full-stack marker selects full-stack prompt", inferPromptBuildType("frontend", "LAMPCode_SELECTED_BUILD_TYPE: fullstack\nLAMPCode_SELECTED_DATABASE: none"), "fullstack");
expectValue("explicit frontend metadata overrides a legacy full-stack prefix", inferPromptBuildType("frontend", "EXISTING FULLSTACK EDIT: nextjs\nLAMPCode_SELECTED_BUILD_TYPE: frontend"), "frontend");

expectValue("legacy Vite sandbox can be reused for React", canReuseSandboxForFramework(null, "react"), true);
expectValue("legacy Vite sandbox is not reused for Next.js", canReuseSandboxForFramework(null, "nextjs"), false);
expectValue("Next.js sandbox is reused for Next.js", canReuseSandboxForFramework("nextjs", "nextjs"), true);
expectValue("Next.js sandbox is replaced for React", canReuseSandboxForFramework("nextjs", "react"), false);

console.log("\n— skill routing follows trusted architecture markers —");
const nextFrontendSkills = await loadRelevantSkillsForPrompt([
  "FRONTEND BUILD: Build a local dashboard.",
  "LAMPCode_SELECTED_BUILD_TYPE: frontend",
  "LAMPCode_SELECTED_FRAMEWORK: nextjs",
  "LAMPCode_SELECTED_DATABASE: none",
  "LAMPCode_SELECTED_BACKEND_RUNTIME: none",
].join("\n"), "frontend");
expectValue("Next.js production skill is available for frontend-only Next builds", nextFrontendSkills.includes("## Skill: nextjs-production"), true);
expectValue("frontend-only Next build does not receive Supabase RLS", nextFrontendSkills.includes("## Skill: supabase-rls"), false);
expectValue("frontend-only Next build does not receive database RLS", nextFrontendSkills.includes("## Skill: database-rls"), false);

const reactNoDbSkills = await loadRelevantSkillsForPrompt([
  "FULLSTACK BUILD: React with a Hono API.",
  "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
  "LAMPCode_SELECTED_FRAMEWORK: react",
  "LAMPCode_SELECTED_DATABASE: none",
  "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
].join("\n"), "fullstack");
expectValue("React/Hono skill follows a React backend decision", reactNoDbSkills.includes("## Skill: fullstack-hono"), true);
expectValue("database-free Hono does not receive Supabase RLS", reactNoDbSkills.includes("## Skill: supabase-rls"), false);

const supabaseSkills = await loadRelevantSkillsForPrompt([
  "FULLSTACK BUILD: a SaaS app.",
  "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
  "LAMPCode_SELECTED_FRAMEWORK: nextjs",
  "LAMPCode_SELECTED_DATABASE: supabase",
  "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
].join("\n"), "fullstack");
expectValue("Next.js Supabase build receives Supabase RLS skill", supabaseSkills.includes("## Skill: supabase-rls"), true);
expectValue("Next.js Supabase build receives database security guidance", supabaseSkills.includes("## Skill: database-rls"), true);

console.log("\nAll model-owned build architecture cases passed.");
