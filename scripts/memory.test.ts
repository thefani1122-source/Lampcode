/**
 * Cases for the deterministic project-memory generator.
 *
 * No test runner in this repo, so this is a plain script — `npm test` runs it.
 *
 * The property that matters most is the round trip: build N's memory has to be
 * readable by build N+1, because the prompt history is the one thing that
 * accumulates rather than being re-derived. If that parse breaks, memory
 * silently forgets everything the user asked for before the current build —
 * and silently is exactly how the old generator stopped working for months.
 */

import {
  generateProjectMemory,
  parseHistory,
  detectStack,
  extractTables,
  extractTokens,
} from "../src/agents/memory-generator.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.log(`✘ ${name}\n    got:  ${g}\n    want: ${w}`);
  } else {
    console.log(`✔ ${name}`);
  }
}

// ── The round trip ────────────────────────────────────────────────────────────

const files1 = {
  "src/App.tsx": 'import { useState } from "react";\nlocalStorage.getItem("x");',
  "src/views/Dashboard.tsx": "export const Dashboard = () => null;",
};
const m1 = generateProjectMemory({
  files: files1, prompt: "Build a CRM with a dashboard and a client table.", existingMemory: null,
});
check("first build records its prompt", parseHistory(m1), [
  "Build a CRM with a dashboard and a client table.",
]);

const m2 = generateProjectMemory({
  files: files1, prompt: "Make the hero subheading shorter.", existingMemory: m1,
});
check("the second build appends, keeping the first", parseHistory(m2), [
  "Build a CRM with a dashboard and a client table.",
  "Make the hero subheading shorter.",
]);

const m3 = generateProjectMemory({ files: files1, prompt: "Add a settings view.", existingMemory: m2 });
check("history keeps accumulating in order", parseHistory(m3).length, 3);
check("oldest entry survives three builds", parseHistory(m3)[0], "Build a CRM with a dashboard and a client table.");

// The cap has to bite from the OLD end — the newest intent is the one an edit
// needs most.
let rolling = generateProjectMemory({ files: files1, prompt: "p1", existingMemory: null });
for (let i = 2; i <= 12; i++) {
  rolling = generateProjectMemory({ files: files1, prompt: `p${i}`, existingMemory: rolling });
}
check("history is capped at 8", parseHistory(rolling).length, 8);
check("the cap drops the oldest, not the newest", parseHistory(rolling), [
  "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12",
]);

// ── parseHistory on hostile input ─────────────────────────────────────────────

check("no memory yields no history", parseHistory(null), []);
check("memory in the OLD LLM shape yields no history", parseHistory("# Project Memory\n\n## What Was Built\nA CRM."), []);
check("empty string yields no history", parseHistory(""), []);
// It must stop at the next heading, or the Stack bullets would become history.
check(
  "parsing stops at the next section",
  parseHistory("## What the user asked for\n1. first\n2. second\n\n## Stack\n3. not a prompt"),
  ["first", "second"],
);
check(
  "non-numbered lines in the section are ignored",
  parseHistory("## What the user asked for\nIn the user's own words.\n1. real prompt\n- a bullet"),
  ["real prompt"],
);

// A very long prompt is truncated rather than carried in full into every
// future edit's system prompt.
const longPrompt = "x".repeat(500);
const mLong = generateProjectMemory({ files: files1, prompt: longPrompt, existingMemory: null });
const entry = parseHistory(mLong)[0] ?? "";
check("a long prompt is truncated", entry.length <= 240, true);
check("truncation is marked", entry.endsWith("…"), true);

// ── detectStack ───────────────────────────────────────────────────────────────

check(
  "frontend-only with localStorage",
  detectStack({ "src/App.tsx": 'localStorage.setItem("a","b")' }),
  [
    "Frontend: React + Vite",
    "Backend: none — frontend only",
    "Data: localStorage",
    "Styling: Tailwind v4 with the template's design tokens",
  ],
);
check(
  "a Python backend is detected from main.py",
  detectStack({ "src/server/main.py": "from fastapi import FastAPI\napp = FastAPI()" })[1],
  "Backend: FastAPI on :3001 (uvicorn)",
);
check(
  "a Node backend is detected from src/server/*.ts",
  detectStack({ "src/server/index.ts": 'import { Hono } from "hono"' })[1],
  "Backend: Hono on :3001",
);
check(
  "Supabase and mongoose are both reported",
  detectStack({
    "src/a.ts": 'import { createClient } from "@supabase/supabase-js"',
    "src/b.ts": 'import mongoose from "mongoose"',
  })[2],
  "Data: Supabase, MongoDB (mongoose)",
);
check(
  "charting and animation libraries are named",
  detectStack({ "src/App.tsx": 'import { LineChart } from "recharts"\nimport { motion } from "motion/react"' })[0],
  "Frontend: React + Vite, Motion, Recharts",
);
// A package named only in a .css or .md file is not an import.
check(
  "non-source files do not contribute to the stack",
  detectStack({ "notes.md": "we should use recharts and mongoose" })[0],
  "Frontend: React + Vite",
);

// ── extractTables ─────────────────────────────────────────────────────────────

check(
  "CREATE TABLE variants are all picked up",
  extractTables({
    "src/db/schema.sql":
      "CREATE TABLE clients (id uuid);\n" +
      "create table if not exists deals (id uuid);\n" +
      'CREATE TABLE "quoted_name" (id uuid);\n' +
      "CREATE TABLE public.notes (id uuid);",
  }),
  ["clients", "deals", "quoted_name", "notes"],
);
check("duplicate table names are collapsed", extractTables({
  "a.sql": "CREATE TABLE t (id int);", "b.sql": "CREATE TABLE t (id int);",
}), ["t"]);
check("no SQL files means no tables", extractTables({ "src/App.tsx": "CREATE TABLE nope (id int)" }), []);
check("an empty SQL file means no tables", extractTables({ "a.sql": "   " }), []);

// ── extractTokens ─────────────────────────────────────────────────────────────

check(
  "the :root block's variables are extracted",
  extractTokens({ "src/app.css": ":root { --primary: #ff0000; --radius: 8px; }" }),
  "--primary: #ff0000; --radius: 8px",
);
check(
  "a :root block with no custom properties is not tokens",
  extractTokens({ "src/app.css": ":root { color: red; }" }),
  null,
);
check("no css file means no tokens", extractTokens({ "src/App.tsx": ":root { --a: 1 }" }), null);
check("a css file with no :root means no tokens", extractTokens({ "src/app.css": ".x { color: red }" }), null);

// ── The document ──────────────────────────────────────────────────────────────

const full = generateProjectMemory({
  files: {
    "src/App.tsx": "export default function App() { return null }",
    "src/views/Dashboard.tsx": "export const Dashboard = () => null",
    "src/views/Settings.tsx": "export const Settings = () => null",
    "src/components/Card.tsx": "export const Card = () => null",
    "src/lib/totals.ts": "export const subtotal = () => 0",
    "src/lib/totals.test.ts": 'import { it } from "vitest"',
    "src/server/index.ts": 'import { Hono } from "hono"',
    "src/db/schema.sql": "CREATE TABLE clients (id uuid);",
    "src/app.css": ":root { --primary: #0a0a0a; }",
  },
  prompt: "Build a CRM.",
  existingMemory: null,
});

check("views are listed", /views: src\/views\/Dashboard\.tsx, src\/views\/Settings\.tsx/.test(full), true);
check("components are listed", /components: src\/components\/Card\.tsx/.test(full), true);
check("logic modules are listed", /logic modules: src\/lib\/totals\.ts/.test(full), true);
check("tests are listed separately", /tests: src\/lib\/totals\.test\.ts/.test(full), true);
// A test file must not be counted as a logic module too, or the counts lie.
check("a test file is not also a logic module", /logic modules: [^\n]*totals\.test\.ts/.test(full), false);
check("backend files are listed when there is a backend", /backend files: src\/server\/index\.ts/.test(full), true);
check("declared tables are named", /tables declared in SQL: clients/.test(full), true);
check("design tokens are carried", /--primary: #0a0a0a/.test(full), true);
check("tokens come with an instruction not to change them", /must not change a value/.test(full), true);
check("it says it was derived, not written by a model", /no model call/.test(full), true);

// Memory sits beside the file manifest in the same prompt. Repeating the
// manifest's per-file exports here would spend the edit's context twice.
check("it does not restate the manifest's export lists", /exports:/.test(full), false);

const noBackend = generateProjectMemory({
  files: { "src/App.tsx": "export default () => null" }, prompt: "p", existingMemory: null,
});
check("no backend section when there is no backend", /backend files:/.test(noBackend), false);
check("no token section when the project has no tokens", /Design tokens in use/.test(noBackend), false);
check("absence of SQL is stated rather than omitted", /no SQL schema in this project/.test(noBackend), true);

// An empty project must still produce a usable document rather than throwing.
const empty = generateProjectMemory({ files: {}, prompt: "start a project", existingMemory: null });
check("an empty project still produces memory", empty.startsWith("# Project Memory"), true);
check("an empty project still records the prompt", parseHistory(empty), ["start a project"]);

// It is injected into every edit's system prompt, so size matters.
check("a sizeable project's memory stays compact", full.length < 2_500, true);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
