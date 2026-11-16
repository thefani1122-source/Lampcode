/**
 * Context Orchestration & Engineering Memory Regression Test Suite
 *
 * Verifies:
 * 1. Task classification & explicit instruction precedence
 * 2. Task-aware project file selection & storage preservation
 * 3. Structured engineering decision memory, project scoping & secret redaction
 * 4. Progressive tool disclosure & query-mode read-only safety
 * 5. Safe context compaction & protocol preservation
 */

import { ContextOrchestrator, PRECEDENCE_HIERARCHY } from "../src/context/orchestrator.js";
import { ProjectIndex } from "../src/context/project-index.js";
import { EngineeringMemoryManager } from "../src/context/engineering-memory.js";
import { ToolDisclosure, QUERY_MODE_READONLY_TOOL_NAMES } from "../src/agents/tool-disclosure.js";
import { ContextCompactor, type ConversationMessage } from "../src/agents/context-compactor.js";
import { TOOL_DEFINITIONS, AGENTIC_BUILD_TOOLS } from "../src/agents/tools.js";

let checks = 0;
let failures = 0;

function ok(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`✔ ${name}`);
  } else {
    failures++;
    console.error(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

async function runTests(): Promise<void> {
  console.log("\n── 1. Precedence Hierarchy & Task Classification ──");
  {
    const precedenceContract = ContextOrchestrator.formatPrecedenceContract();
    ok("precedence contract contains security invariants", precedenceContract.includes("SECURITY & PLATFORM INVARIANTS"));
    ok("precedence contract contains user requirements priority", precedenceContract.includes("USER REQUIREMENTS"));
    ok("precedence contract warns against silent backend downgrade", precedenceContract.includes("do not silently downgrade"));
    ok("precedence hierarchy has 5 ordered tiers", PRECEDENCE_HIERARCHY.length === 5);
    ok("tier 1 is security invariant", PRECEDENCE_HIERARCHY[0]?.priority === 1);

    const uiTask = ContextOrchestrator.classifyTask("Change button color to dark blue and adjust padding", { "src/App.tsx": "" });
    ok("classifies UI styling prompt as ui_edit", uiTask.category === "ui_edit");

    const bugTask = ContextOrchestrator.classifyTask("Fix crash 500 error when submitting form", { "src/App.tsx": "" });
    ok("classifies error report as bug_repair", bugTask.category === "bug_repair");

    const backendTask = ContextOrchestrator.classifyTask("Add postgres database schema and auth route", { "src/App.tsx": "" });
    ok("classifies DB/auth prompt as backend_change", backendTask.category === "backend_change");

    const queryTask = ContextOrchestrator.classifyTask("Explain how the auth routing works in this project", { "src/App.tsx": "" });
    ok("classifies explanation request as code_review_query", queryTask.category === "code_review_query");
  }

  console.log("\n── 2. Task-Aware Project File Selection & Storage Safety ──");
  {
    const allProjectFiles: Record<string, string> = {
      "CONTRACT.md": "# Project Contract\nStrict rules",
      "package.json": '{"name":"demo"}',
      "src/App.tsx": "export function App() { return <Button>Click</Button>; }",
      "src/components/Button.tsx": "export function Button(props: any) { return <button {...props} />; }",
      "src/server/routes/api.ts": "export function handleApi() { return 'ok'; }",
      "src/db/schema.sql": "CREATE TABLE users (id text);",
    };

    const uiSelection = ProjectIndex.selectFilesForTask(allProjectFiles, "ui_edit", "Change button styling");
    ok("ui task selects Button.tsx", uiSelection.selectedPaths.includes("src/components/Button.tsx"));
    ok("pinned CONTRACT.md is always included", uiSelection.selectedPaths.includes("CONTRACT.md"));
    ok("original project files are untouched in storage", Object.keys(allProjectFiles).length === 6);

    const backendSelection = ProjectIndex.selectFilesForTask(allProjectFiles, "backend_change", "Add user endpoint");
    ok("backend task prioritizes route and schema", backendSelection.selectedPaths.includes("src/server/routes/api.ts"));
  }

  console.log("\n── 3. Engineering Decision Memory & Secret Redaction ──");
  {
    const projA = `proj_${Date.now()}_a`;
    const projB = `proj_${Date.now()}_b`;

    const dec1 = await EngineeringMemoryManager.recordDecision({
      projectId: projA,
      changeType: "bugfix",
      userRequirement: "Fix auth token leak with sk_live_secret1234567890abcdef",
      observedFailure: "Token leaked in headers",
      rootCause: "Unredacted Bearer header",
      rationale: "Redact token before passing to client",
      decision: "Sanitize outgoing headers",
      implementation: "stripAuthorization(req)",
      affectedFiles: ["src/server/auth.ts"],
      affectedSymbols: ["stripAuthorization"],
      verificationStatus: "verified",
      tags: ["auth", "security"],
    });

    ok("decision record created with ID", dec1.id.startsWith("dec_"));
    ok("secrets are redacted from user requirement", !dec1.userRequirement.includes("sk_live_secret"));
    ok("user requirement contains redacted placeholder", dec1.userRequirement.includes("[REDACTED_SECRET]"));

    // Project scoping test
    const foundA = await EngineeringMemoryManager.getDecision(dec1.id, projA);
    ok("retrieves decision within owning project", foundA !== null && foundA.id === dec1.id);

    const foundB = await EngineeringMemoryManager.getDecision(dec1.id, projB);
    ok("cannot retrieve decision from another project", foundB === null);

    // Search by symbol
    const symbolHistory = await EngineeringMemoryManager.getSymbolHistory(projA, "stripAuthorization");
    ok("finds decision by affected symbol", symbolHistory.length > 0 && symbolHistory[0]?.id === dec1.id);

    // Supersession test
    const dec2 = await EngineeringMemoryManager.recordDecision({
      projectId: projA,
      changeType: "refactor",
      userRequirement: "Update auth middleware to use OAuth2",
      rationale: "Upgrade from legacy token",
      decision: "Migrate stripAuthorization to OAuth2 handler",
      implementation: "newOAuthHandler()",
      supersedes: [dec1.id],
    });

    const updatedDec1 = await EngineeringMemoryManager.getDecision(dec1.id, projA);
    ok("superseded decision records successor ID", updatedDec1?.supersededBy === dec2.id);
  }

  console.log("\n── 4. Progressive Tool Disclosure & Query Mode Safety ──");
  {
    const allTools = [...TOOL_DEFINITIONS, ...AGENTIC_BUILD_TOOLS];
    const queryTools = ToolDisclosure.filterForTask(allTools, "code_review_query");

    ok("query tools are strictly limited", queryTools.length > 0);
    ok("query tools NEVER include write_files", !queryTools.some((t) => t.name === "write_files"));
    ok("query tools NEVER include edit_file", !queryTools.some((t) => t.name === "edit_file"));
    ok("query tools NEVER include delete_file", !queryTools.some((t) => t.name === "delete_file"));
    ok("query tools NEVER include deploy_app", !queryTools.some((t) => t.name === "deploy_app"));
    ok("query tools NEVER include vercel_write", !queryTools.some((t) => t.name === "vercel_write"));
    ok("query tools include search_engineering_decisions", queryTools.some((t) => t.name === "search_engineering_decisions"));
    ok("query tools include read_file", queryTools.some((t) => t.name === "read_file"));

    for (const tool of queryTools) {
      ok(`query tool "${tool.name}" is in readonly allowlist`, QUERY_MODE_READONLY_TOOL_NAMES.has(tool.name));
    }
  }

  console.log("\n── 4b. Dynamic MCP Read-Only Disclosure ──");
  {
    const dynamicReadTool = {
      name: "linear__list_issues",
      description: "List issues from the connected Linear workspace",
      input_schema: { type: "object" as const, properties: {} },
    };
    const dynamicWriteTool = {
      name: "linear__create_issue",
      description: "Create an issue",
      input_schema: { type: "object" as const, properties: {} },
    };
    const disclosed = ToolDisclosure.filterForTask(
      [...TOOL_DEFINITIONS, ...AGENTIC_BUILD_TOOLS, dynamicReadTool, dynamicWriteTool],
      "code_review_query",
      [dynamicReadTool.name],
    );
    ok("trusted dynamically classified MCP read tool is available", disclosed.some((tool) => tool.name === dynamicReadTool.name));
    ok("dynamic MCP write tool remains blocked", !disclosed.some((tool) => tool.name === dynamicWriteTool.name));
    ok("review_code is available in query mode", disclosed.some((tool) => tool.name === "review_code"));
    ok("read_project_file is available in query mode", disclosed.some((tool) => tool.name === "read_project_file"));
  }

  console.log("\n── 5. Safe Context Compaction ──");
  {
    const messages: ConversationMessage[] = [
      { role: "system", content: "You are LampCode." },
      { role: "user", content: "Build a habit tracker app with accounts." },
      { role: "assistant", content: [
        { type: "tool_use", id: "tool_old_1", name: "read_file", input: { path: "src/App.tsx" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool_old_1", content: ("export function App() {\\n  // important structure\\n  return <main>Habit tracker</main>;\\n  error: none\\n").repeat(180) },
      ] },
      { role: "assistant", content: [
        { type: "tool_use", id: "tool_recent_1", name: "list_files", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool_recent_1", content: "src/App.tsx\\nsrc/components/Tracker.tsx" },
        { type: "text", text: "Active error: missing dependency 'lucide-react'." },
      ] },
    ];

    const tokensBefore = ContextCompactor.estimateTokens(messages);
    ok("initial messages exceed 2000 tokens", tokensBefore > 2000);
    ok("input tool_use/tool_result pairing is valid", ContextCompactor.hasValidToolPairs(messages));

    const compacted = ContextCompactor.compact(messages, 1000, 1);
    ok("compactor triggered compaction", compacted.didCompact);
    ok("message count is stable so all tool calls/results remain present", compacted.compactedMessages.length === messages.length);
    ok("system message preserved", compacted.compactedMessages[0]?.role === "system");
    ok("original user prompt preserved", (compacted.compactedMessages[1]?.content as string).includes("Build a habit tracker"));
    const oldResult = compacted.compactedMessages[3]?.content;
    const recentResult = compacted.compactedMessages[5]?.content;
    ok("old tool result is compacted rather than dropped", Array.isArray(oldResult) && String(oldResult[0]?.type === "tool_result" ? oldResult[0].content : "").includes("compacted"));
    ok("recent tool result remains intact", Array.isArray(recentResult) && recentResult[0]?.type === "tool_result" && recentResult[0].content === "src/App.tsx\\nsrc/components/Tracker.tsx");
    ok("tool protocol remains valid after compaction", compacted.protocolValid && ContextCompactor.hasValidToolPairs(compacted.compactedMessages));
    ok("active error label is preserved", Array.isArray(recentResult) && recentResult.some((block) => block.type === "text" && block.text.includes("Active error")));
    ok("compaction reduces context size", compacted.tokensAfter < compacted.tokensBefore);
    const malformed: ConversationMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "missing-result", name: "read_file", input: {} }] },
    ];
    const refused = ContextCompactor.compact(malformed, 1, 1);
    ok("malformed tool history is left untouched", !refused.didCompact && !refused.protocolValid);
  }

  console.log(`\n========================================`);
  console.log(`Summary: ${checks} checks run, ${failures} failures.`);
  console.log(`========================================\n`);

  if (failures > 0) {
    process.exit(1);
  }
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
