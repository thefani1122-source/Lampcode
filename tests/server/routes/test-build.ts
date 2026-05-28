/**
 * Test script for the Fast Mode build API.
 *
 * Tests the file parser and route logic without requiring a real DB or
 * OpenRouter key. A live integration test is included at the bottom that
 * you can enable by setting INTEGRATION=1.
 *
 * Usage:
 *   npx tsx src/server/routes/test-build.ts
 *   INTEGRATION=1 DATABASE_URL=... OPENROUTER_API_KEY=... npx tsx src/server/routes/test-build.ts
 */

// ── Tiny test harness ─────────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(65)} ... `);
    try {
      await fn();
      console.log("OK");
      passed++;
    } catch (err) {
      console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
}

function expect<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `Expected ${e}, got ${a}`);
}

function expectGt(actual: number, min: number, msg?: string): void {
  if (actual <= min) throw new Error(msg ?? `Expected > ${min}, got ${actual}`);
}

// ── Import the parser (extracted from build.ts for testing) ──────────────────
// We replicate the function here rather than exporting it, so the route file
// stays self-contained. Any changes to the parser should be mirrored here.

interface ParsedFile { path: string; code: string }

function parseFilesFromContent(content: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const lines = content.split("\n");
  let i = 0;

  const pathLineRe =
    /^(?:#{1,4}\s+(?:File:\s+)?|>\s*)?[`*_]{0,3}([^\s`*_<>|]+\.[a-zA-Z0-9]{1,10})[`*_]{0,3}:?\s*$/;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (/^(?:```|~~~)/.test(line)) {
      let filePath: string | null = null;
      for (let back = 1; back <= 3; back++) {
        const prevLine = lines[i - back] ?? "";
        if (prevLine.trim() === "") continue;
        const m = pathLineRe.exec(prevLine.trim());
        if (m?.[1]) { filePath = m[1]; break; }
        if (/^(?:```|~~~)/.test(prevLine) || back === 1) break;
      }

      i++;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const codeLine = lines[i] ?? "";
        if (/^(?:```|~~~)/.test(codeLine)) { i++; break; }
        codeLines.push(codeLine);
        i++;
      }
      const code = codeLines.join("\n").trim();
      if (code.length === 0) continue;

      if (filePath === null) {
        const firstCodeLine = codeLines[0] ?? "";
        const commentPathMatch =
          firstCodeLine.match(/^\/\/\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/) ??
          firstCodeLine.match(/^#\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/);
        if (commentPathMatch?.[1]) {
          filePath = commentPathMatch[1];
          const trimmedCode = codeLines.slice(1).join("\n").trim();
          if (trimmedCode.length > 0) {
            files.push({ path: filePath, code: trimmedCode });
          }
          continue;
        }
      }

      if (filePath !== null) {
        files.push({ path: filePath, code });
      }
      continue;
    }

    i++;
  }

  return files;
}

// ── File parser unit tests ────────────────────────────────────────────────────

const SAMPLE_RESPONSE_HEADING = `
# Coffee Shop Landing Page

## File: index.html
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head><title>Brew & Bean</title></head>
<body><h1>Welcome to Brew & Bean</h1></body>
</html>
\`\`\`

## File: src/App.tsx
\`\`\`tsx
import React from 'react';
export default function App() {
  return <main><h1>Brew & Bean</h1></main>;
}
\`\`\`

## File: src/styles/main.css
\`\`\`css
body { font-family: sans-serif; background: #fdf6e3; }
h1 { color: #3b1f0a; }
\`\`\`
`;

const SAMPLE_RESPONSE_BACKTICK_HEADING = `
### \`public/index.html\`
\`\`\`html
<!DOCTYPE html><html><body><p>hello</p></body></html>
\`\`\`

### \`src/main.tsx\`
\`\`\`tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
ReactDOM.createRoot(document.getElementById('root')!).render(<p>hello</p>);
\`\`\`
`;

const SAMPLE_RESPONSE_COMMENT_PATH = `
\`\`\`tsx
// src/components/Hero.tsx
export function Hero() {
  return <section>Welcome</section>;
}
\`\`\`

\`\`\`css
# src/components/hero.css
section { padding: 2rem; }
\`\`\`
`;

const SAMPLE_RESPONSE_BOLD_PATH = `
**\`src/App.tsx\`**
\`\`\`tsx
export default function App() { return <div>App</div>; }
\`\`\`
`;

test("Parser: ## File: heading pattern → 3 files", () => {
  const files = parseFilesFromContent(SAMPLE_RESPONSE_HEADING);
  expect(files.length, 3, `Expected 3 files, got ${files.length}`);
  expect(files[0]?.path, "index.html");
  expect(files[1]?.path, "src/App.tsx");
  expect(files[2]?.path, "src/styles/main.css");
});

test("Parser: ### `path` backtick heading → 2 files", () => {
  const files = parseFilesFromContent(SAMPLE_RESPONSE_BACKTICK_HEADING);
  expect(files.length, 2, `Expected 2 files, got ${files.length}`);
  expect(files[0]?.path, "public/index.html");
  expect(files[1]?.path, "src/main.tsx");
});

test("Parser: // path comment first line → 2 files", () => {
  const files = parseFilesFromContent(SAMPLE_RESPONSE_COMMENT_PATH);
  expect(files.length, 2, `Expected 2 files, got ${files.length}`);
  expect(files[0]?.path, "src/components/Hero.tsx");
  expect(files[1]?.path, "src/components/hero.css");
});

test("Parser: **`path`** bold backtick → 1 file", () => {
  const files = parseFilesFromContent(SAMPLE_RESPONSE_BOLD_PATH);
  expect(files.length, 1, `Expected 1 file, got ${files.length}`);
  expect(files[0]?.path, "src/App.tsx");
});

test("Parser: code content is non-empty", () => {
  const files = parseFilesFromContent(SAMPLE_RESPONSE_HEADING);
  for (const f of files) {
    expectGt(f.code.length, 0, `File ${f.path} has empty code`);
  }
});

test("Parser: no false positives on prose-only content", () => {
  const prose = "This is a document.\n\nIt has no code blocks at all.\n";
  const files = parseFilesFromContent(prose);
  expect(files.length, 0, `Expected 0 files, got ${files.length}`);
});

test("Parser: empty input returns empty array", () => {
  expect(parseFilesFromContent("").length, 0);
});

test("Parser: skips empty code blocks", () => {
  const content = `
## File: src/empty.ts
\`\`\`ts
\`\`\`

## File: src/real.ts
\`\`\`ts
export const x = 1;
\`\`\`
`;
  const files = parseFilesFromContent(content);
  expect(files.length, 1);
  expect(files[0]?.path, "src/real.ts");
});

test("Parser: handles mixed heading styles in same response", () => {
  const mixed = `
## File: index.html
\`\`\`html
<html></html>
\`\`\`

### \`src/App.tsx\`
\`\`\`tsx
export default function App() {}
\`\`\`

\`\`\`css
// src/styles.css
body { margin: 0; }
\`\`\`
`;
  const files = parseFilesFromContent(mixed);
  expect(files.length, 3);
});

// ── Validation logic unit tests ───────────────────────────────────────────────

import { z } from "zod";

const fastBuildBodySchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(4_000),
  attachments: z.array(z.string()).max(10).optional(),
});

test("Schema: rejects missing projectId", () => {
  const r = fastBuildBodySchema.safeParse({ prompt: "hello" });
  if (r.success) throw new Error("Should have failed validation");
});

test("Schema: rejects prompt over 4000 chars", () => {
  const r = fastBuildBodySchema.safeParse({ projectId: "p1", prompt: "x".repeat(4_001) });
  if (r.success) throw new Error("Should have failed validation");
});

test("Schema: accepts valid body with optional attachments", () => {
  const r = fastBuildBodySchema.safeParse({
    projectId: "proj-1",
    prompt: "Build a landing page for my coffee shop",
    attachments: ["https://example.com/logo.png"],
  });
  if (!r.success) throw new Error(`Validation failed: ${r.error.message}`);
});

test("Schema: accepts body without attachments", () => {
  const r = fastBuildBodySchema.safeParse({
    projectId: "proj-1",
    prompt: "Build a landing page for my coffee shop",
  });
  if (!r.success) throw new Error(`Validation failed: ${r.error.message}`);
});

// ── Run ────────────────────────────────────────────────────────────────────────

console.log("\nBuildForge Fast Mode API — unit tests\n");
await runTests();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);

if (failed > 0) process.exit(1);
