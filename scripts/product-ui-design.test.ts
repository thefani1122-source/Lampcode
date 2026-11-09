import { loadRelevantSkillsForPrompt } from "../src/agents/prompt-builder.js";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`PASS: ${name}`);
  }
}

const fullstack = await loadRelevantSkillsForPrompt("Build a Supabase-backed task manager", "fullstack");
check("full-stack builds receive the product UI design contract", fullstack.includes("Product UI Design — Required Standard"));
check("full-stack builds receive the card-based authentication rule", fullstack.includes("420–460px"));
check("full-stack builds receive dashboard composition guidance", fullstack.includes("Summary/KPI cards are supporting information"));
check("full-stack builds receive explicit responsive breakpoints", fullstack.includes("1440") && fullstack.includes("390"));

const frontend = await loadRelevantSkillsForPrompt("Build a portfolio website", "frontend");
check("frontend builds receive the same product UI design contract", frontend.includes("Product UI Design — Required Standard"));

console.log(failures === 0 ? "\nAll product UI design contract tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
