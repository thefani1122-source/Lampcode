/**
 * Smoke-test script for the AgentDispatcher.
 *
 * Usage:
 *   OPENROUTER_API_KEY=<key> npx tsx src/agents/test-dispatch.ts
 *
 * Without a real key the gateway will throw INVALID_KEY; the script
 * catches that and still exercises prompt-building and tier resolution.
 */

import { AgentDispatcher } from "./dispatcher.js";
import { type AgentTaskType } from "./model-gateway.js";

const TASKS: Array<{ agentType: AgentTaskType; description: string }> = [
  {
    agentType: "planning",
    description: "Produce a high-level architecture plan for a URL shortener service.",
  },
  {
    agentType: "frontend",
    description: "Create a React component that displays a list of shortened URLs.",
  },
  {
    agentType: "backend",
    description: "Write a Hono endpoint POST /shorten that accepts a long URL and returns a short code.",
  },
  {
    agentType: "db",
    description: "Design a Drizzle schema for storing URL mappings with click-count tracking.",
  },
  {
    agentType: "security",
    description: "Audit the URL shortener for SSRF, open redirect, and enumeration vulnerabilities.",
  },
  {
    agentType: "connection",
    description: "Wire up a Redis cache in front of the URL lookup endpoint with 60s TTL.",
  },
  {
    agentType: "fix",
    description: "Fix a bug where redirect returns 302 instead of the required 301.",
  },
  {
    agentType: "deploy",
    description: "Write a Dockerfile and GitHub Actions CI workflow for the URL shortener.",
  },
  {
    agentType: "monitor",
    description: "Add Pino structured logging and Prometheus metrics to the URL shortener.",
  },
];

interface TestResult {
  agentType: AgentTaskType;
  status: "ok" | "error";
  modelUsed?: string | undefined;
  tierUsed?: number | undefined;
  durationMs?: number | undefined;
  tokens?: number | undefined;
  error?: string | undefined;
}

async function runTest(
  dispatcher: AgentDispatcher,
  agentType: AgentTaskType,
  description: string,
  sessionId: string,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await dispatcher.dispatch({
      agentType,
      task: {
        description,
        outputFormat: "markdown",
        requirements: ["Keep the response concise (< 200 words)."],
      },
      sessionId,
    });
    return {
      agentType,
      status: "ok",
      modelUsed: result.modelUsed,
      tierUsed: result.tierUsed,
      durationMs: Date.now() - start,
      tokens: result.inputTokens + result.outputTokens,
    };
  } catch (err) {
    return {
      agentType,
      status: "error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const sessionId = crypto.randomUUID();
  const dispatcher = new AgentDispatcher();

  console.log(`\nBuildForge Agent Dispatcher — smoke test`);
  console.log(`Session: ${sessionId}`);
  console.log(`Testing ${TASKS.length} agent types...\n`);

  const results: TestResult[] = [];

  for (const { agentType, description } of TASKS) {
    process.stdout.write(`  ${agentType.padEnd(12)} ... `);
    const result = await runTest(dispatcher, agentType, description, sessionId);
    results.push(result);

    if (result.status === "ok") {
      console.log(
        `OK  model=${result.modelUsed ?? "?"} tier=${result.tierUsed ?? "?"} ` +
        `tokens=${result.tokens ?? 0} (${result.durationMs}ms)`,
      );
    } else {
      console.log(`ERR ${result.error ?? "unknown"} (${result.durationMs}ms)`);
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const err = results.filter((r) => r.status === "error").length;

  console.log(`\nResults: ${ok} passed, ${err} failed out of ${results.length} agents`);

  if (err > 0) {
    console.log("\nFailed agents:");
    for (const r of results) {
      if (r.status === "error") {
        console.log(`  ${r.agentType}: ${r.error ?? ""}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
