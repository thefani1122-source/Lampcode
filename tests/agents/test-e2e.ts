/**
 * End-to-end test: Fast Mode build via real OpenRouter API.
 *
 * Fully standalone — does NOT import any module with a config chain.
 * Requires OPENROUTER_API_KEY in the environment for live tests;
 * skips those tests when the key is absent to keep CI cost-free.
 *
 * Run:  npx tsx src/agents/test-e2e.ts
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parseFilesFromContent } from "./file-parser.js";

// ── Assertion / reporting ─────────────────────────────────────────────────────

let passed = 0;
let skipped = 0;
let failed = 0;

function assert(cond: boolean, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
  passed++;
}

function skip(label: string, reason: string): void {
  console.log(`  – ${label} (skipped: ${reason})`);
  skipped++;
}

function fail(label: string, err: unknown): void {
  console.error(`  ✗ ${label}:`, err instanceof Error ? err.message : String(err));
  failed++;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const SKIP_LIVE = API_KEY.length === 0;

// Use the cheapest available model to keep test cost near zero
const CHEAP_MODEL = "openai/gpt-4o-mini";

// ── Raw OpenRouter SSE helper ─────────────────────────────────────────────────

interface RawMessage { role: "system" | "user" | "assistant"; content: string; }

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: RawMessage[],
  maxTokens = 512,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://buildforge.dev",
      "X-Title": "BuildForge-E2E-Test",
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const bodyStream = resp.body;
  if (bodyStream === null) throw new Error("Empty response body");

  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") break outer;
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          const delta = (data["choices"] as Array<{ delta?: { content?: string } }>)?.[0]?.delta;
          if (delta?.content) content += delta.content;
          const usage = data["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? 0;
            outputTokens = usage.completion_tokens ?? 0;
          }
        } catch { /* skip non-JSON */ }
      }
    }
  }
  reader.releaseLock();
  return { content, inputTokens, outputTokens };
}

// ── Unit tests (no network) ───────────────────────────────────────────────────

console.log("\n── file-parser unit tests ──");

(function testParserBasic() {
  const label = "parseFilesFromContent — heading + fence";
  try {
    const md = `
## File: src/index.ts

\`\`\`typescript
console.log("hello");
\`\`\`
`;
    const files = parseFilesFromContent(md);
    assert(files.length === 1, "should find 1 file");
    assert(files[0]?.path === "src/index.ts", "path");
    assert(files[0]?.code.includes("console.log"), "code");
    ok(label);
  } catch (e) { fail(label, e); }
})();

(function testParserCommentPath() {
  const label = "parseFilesFromContent — comment path in fence";
  try {
    const md = `
\`\`\`tsx
// src/App.tsx
import React from "react";
export default function App() { return <div>Hello</div>; }
\`\`\`
`;
    const files = parseFilesFromContent(md);
    assert(files.length === 1, "should find 1 file");
    assert(files[0]?.path === "src/App.tsx", "path");
    assert(files[0]?.code.includes("import React"), "code stripped comment line");
    ok(label);
  } catch (e) { fail(label, e); }
})();

(function testParserMultipleFiles() {
  const label = "parseFilesFromContent — multiple files";
  try {
    const md = `
### \`src/a.ts\`

\`\`\`typescript
export const a = 1;
\`\`\`

### \`src/b.ts\`

\`\`\`typescript
export const b = 2;
\`\`\`
`;
    const files = parseFilesFromContent(md);
    assert(files.length === 2, `expected 2, got ${files.length}`);
    assert(files[0]?.path === "src/a.ts", "first file path");
    assert(files[1]?.path === "src/b.ts", "second file path");
    ok(label);
  } catch (e) { fail(label, e); }
})();

(function testParserEmpty() {
  const label = "parseFilesFromContent — no fences returns empty array";
  try {
    const files = parseFilesFromContent("Just some prose with no code blocks.");
    assert(files.length === 0, "should be empty");
    ok(label);
  } catch (e) { fail(label, e); }
})();

// ── model-gateway source verification (no import, read the source file) ───────

console.log("\n── MODEL_TIERS verification (source text) ──");

async function verifyModelTiers() {
  const label = "MODEL_TIERS — correct model IDs in source";
  try {
    const src = await readFile(join(import.meta.dirname ?? ".", "model-gateway.ts"), "utf8");
    const expectedEntries: [string, string][] = [
      ["planning", "anthropic/claude-opus-4-6"],
      ["frontend", "moonshotai/kimi-k2.6"],
      ["backend",  "anthropic/claude-sonnet-4-6"],
      ["db",       "anthropic/claude-sonnet-4-6"],
      ["security", "deepseek/deepseek-v4-pro"],
      ["connection","deepseek/deepseek-v4-flash"],
      ["fix",      "anthropic/claude-sonnet-4-6"],
      ["deploy",   "deepseek/deepseek-v4-flash"],
    ];
    for (const [agentType, modelId] of expectedEntries) {
      assert(
        src.includes(`"${modelId}"`),
        `MODEL_TIERS.${agentType}: expected "${modelId}" in source`,
      );
    }
    ok(label);
  } catch (e) { fail(label, e); }
}

await verifyModelTiers();

// ── Live OpenRouter API tests ─────────────────────────────────────────────────

console.log("\n── Live OpenRouter API tests ──");

async function runLiveTests() {
  // Test 1: Basic streaming completion
  {
    const label = "callOpenRouter — streams content chunks";
    if (SKIP_LIVE) { skip(label, "OPENROUTER_API_KEY not set"); }
    else {
      try {
        const { content, outputTokens } = await callOpenRouter(
          API_KEY,
          CHEAP_MODEL,
          [{ role: "user", content: "Reply with exactly: Hello, BuildForge!" }],
          32,
        );
        assert(content.length > 0, "content must not be empty");
        assert(outputTokens >= 0, "outputTokens must be reported");
        ok(label);
      } catch (e) { fail(label, e); }
    }
  }

  // Test 2: Fast-mode pipeline — agent produces parseable files
  {
    const label = "Fast-mode pipeline — agent output is parseable";
    if (SKIP_LIVE) { skip(label, "OPENROUTER_API_KEY not set"); }
    else {
      try {
        const prompt = [
          "Generate a minimal React app with exactly two files.",
          "Format each file like this example:",
          "## File: src/App.tsx",
          "```tsx",
          "// code here",
          "```",
          "",
          "File 1: src/App.tsx — a React component that renders <h1>Hello</h1>",
          "File 2: src/index.ts — exports `export { default } from './App';`",
        ].join("\n");

        const { content } = await callOpenRouter(
          API_KEY,
          CHEAP_MODEL,
          [
            { role: "system", content: "You are a code generation assistant. Output only code files, no prose." },
            { role: "user", content: prompt },
          ],
          512,
        );

        assert(content.length > 50, "non-trivial content expected");
        const files = parseFilesFromContent(content);
        assert(
          files.length >= 1,
          `expected ≥1 parsed file, got ${files.length}\ncontent preview:\n${content.slice(0, 400)}`,
        );
        assert(files.every((f) => f.path.length > 0), "all files have paths");
        assert(files.every((f) => f.code.length > 0), "all files have code");
        ok(label);
      } catch (e) { fail(label, e); }
    }
  }

  // Test 3: Models endpoint reachability
  {
    const label = "OpenRouter /models endpoint — reachable";
    if (SKIP_LIVE) { skip(label, "OPENROUTER_API_KEY not set"); }
    else {
      try {
        const res = await fetch(`${OPENROUTER_BASE}/models`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        assert(res.ok, `Expected 200, got ${res.status}`);
        ok(label);
      } catch (e) { fail(label, e); }
    }
  }

  // Test 4: Invalid API key → 4xx response (401 or 403)
  {
    const label = "OpenRouter — invalid key returns 4xx error";
    try {
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid-key-for-testing-xyz",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
      });
      assert(res.status >= 400 && res.status < 500, `Expected 4xx, got ${res.status}`);
      ok(label);
    } catch (e) { fail(label, e); }
  }
}

await runLiveTests();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
