import { classifyMcpQueryIntent, mayBeMcpQuery } from "../src/agents/mcp-query-intent.js";

let checks = 0;
function check(name: string, got: unknown, expected: unknown): void {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`ok ${name}`);
}

const readCases = [
  "Go to Vercel and check recent deployments, then tell me what you find",
  "Show the latest deployment status in Vercel",
  "Can you inspect the last deploy and its build logs?",
  "List my recent GitHub pull requests",
  "Summarize the latest Sentry errors",
  "What's the current status of my Notion pages?",
  "Check my MongoDB Atlas collections",
  "List Framer CMS pages",
  "Check recent deployments",
];
for (const prompt of readCases) {
  check(`read-only query recognized: ${prompt}`, classifyMcpQueryIntent(prompt).handled, true);
  check(`client prefilter catches: ${prompt}`, mayBeMcpQuery(prompt), true);
}

const buildOrWriteCases = [
  "Build me a dashboard showing recent Vercel deployments",
  "Check the latest Vercel deployments and fix the code",
  "Deploy this app to Vercel",
  "Create a GitHub repository and push the code",
  "Update the Vercel environment variables",
  "Build a deployment monitor website",
  "Check recent Vercel deployments, then fix it",
  "Check recent deployments and restart the failed service",
];
for (const prompt of buildOrWriteCases) {
  check(`write/build request stays out of read-only mode: ${prompt}`, classifyMcpQueryIntent(prompt).handled, false);
}

check("empty prompt is not an MCP query", classifyMcpQueryIntent("").handled, false);
console.log(`All ${checks} MCP query-intent cases passed.`);
