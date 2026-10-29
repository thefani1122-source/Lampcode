import { isReadOnlyMcpQuery } from "../src/agents/mcp-intent.js";

const cases: Array<{ name: string; prompt: string; expected: boolean }> = [
  {
    name: "the reported Vercel deployment lookup enters query-only mode",
    prompt: "Go to Vercel and check recent deployments, then tell me what happened.",
    expected: true,
  },
  {
    name: "natural-language latest deployment question is read-only",
    prompt: "Can you show me the latest Vercel deployments?",
    expected: true,
  },
  {
    name: "build logs are data, not a build instruction",
    prompt: "Check the recent build logs and errors.",
    expected: true,
  },
  {
    name: "GitHub repository lookup is read-only",
    prompt: "List the recent GitHub repositories and pull requests.",
    expected: true,
  },
  {
    name: "provider and object can be inferred from a query without a provider name",
    prompt: "Check the current deployment status.",
    expected: true,
  },
  {
    name: "explicit code-building request must remain on build route",
    prompt: "Build a dashboard that shows recent deployments.",
    expected: false,
  },
  {
    name: "deployment mutation must not use read-only mode",
    prompt: "Check recent deployments and redeploy the failed one.",
    expected: false,
  },
  {
    name: "combined read and deploy actions must not use read-only mode",
    prompt: "Check recent deployments and deploy the failed one.",
    expected: false,
  },
  {
    name: "polite build request must stay in build mode",
    prompt: "Could you please build a dashboard that shows recent deployments?",
    expected: false,
  },
  {
    name: "polite read request remains eligible for query-only mode",
    prompt: "Could you please list recent Vercel deployments?",
    expected: true,
  },
  {
    name: "write request must not use read-only mode",
    prompt: "Create a GitHub issue for the failing deployment.",
    expected: false,
  },
  {
    name: "source-file inspection stays in workspace mode",
    prompt: "List my project source files.",
    expected: false,
  },
  {
    name: "ordinary coding prompt stays in build mode",
    prompt: "Fix the authentication bug in my app.",
    expected: false,
  },
  {
    name: "recency alone is not enough without an external object",
    prompt: "What should I build next?",
    expected: false,
  },
];

let failures = 0;
for (const test of cases) {
  const actual = isReadOnlyMcpQuery(test.prompt);
  if (actual !== test.expected) {
    failures++;
    console.error(`FAIL ${test.name}: expected ${test.expected}, got ${actual} (${test.prompt})`);
  } else {
    console.log(`ok ${test.name}`);
  }
}
if (failures > 0) {
  throw new Error(`${failures} MCP intent cases failed`);
}
console.log(`All ${cases.length} MCP intent cases passed.`);
