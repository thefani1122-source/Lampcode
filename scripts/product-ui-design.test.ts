import { PromptBuilder } from "../src/agents/prompt-builder.js";
import { executeTool } from "../src/agents/tools.js";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`PASS: ${name}`);
  }
}

const builder = new PromptBuilder();
const built = await builder.build(
  "query",
  {
    description: "Help me plan a React SaaS dashboard.",
    outputFormat: "markdown",
    toolsEnabled: true,
  },
  {
    projectId: "product-ui-design-skill-test",
    userId: "product-ui-design-skill-test",
    mode: "fast",
    prompt: "Help me plan a React SaaS dashboard.",
  },
);

check("the assistant discovers the product UI skill by metadata", built.systemPrompt.includes("- product-ui-design:"));
check("the assistant is told that full skill bodies load only on demand", built.systemPrompt.includes("their bodies are NOT injected automatically"));
check("the product UI body is not injected into every query prompt", !built.systemPrompt.includes("# Product UI Design — Required Standard"));

const uiGuidance = await executeTool(
  "load_skill",
  JSON.stringify({ name: "product-ui-design" }),
  {} as never,
);
check("the complete product UI design contract can be explicitly loaded", uiGuidance.includes("# Product UI Design — Required Standard"));
check("the loaded guide retains the card-based authentication rule", uiGuidance.includes("420–460px"));
check("the loaded guide retains dashboard composition guidance", uiGuidance.includes("Summary/KPI cards are supporting information"));
check("the loaded guide retains explicit responsive breakpoints", uiGuidance.includes("1440") && uiGuidance.includes("390"));

if (failures) {
  console.error(`\n${failures} product UI skill test(s) failed.`);
  process.exit(1);
}
console.log("\nAll on-demand product UI skill tests passed.");
