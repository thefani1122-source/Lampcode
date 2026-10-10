/**
 * THE COMPLETION-AUDIT PROBE SET — parked item 4, finally runnable.
 *
 * The one thing the audit has never shown on demand is that it catches a REAL
 * missing requirement. You cannot make a model forget to order, so the plan
 * agreed on 2026-10-07 is the inverse: take known-good generated output, MUTATE
 * it in ways this repo has actually measured, keep the criteria fixed, and see
 * whether the audit notices.
 *
 * The UNMUTATED original is run too, and that half matters just as much: it
 * measures PRECISION, which is what Finding 6 was — a confident, specific,
 * entirely false "contradicted" verdict over working code. A recall number on
 * its own would hide exactly that failure.
 *
 * No builds. One audit dispatch per variant.
 */
import { readFileSync, writeFileSync } from "node:fs";

const { ProxyAgent, setGlobalDispatcher } = await import("undici");
const proxy = process.env["HTTPS_PROXY"] ?? process.env["https_proxy"];
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const { auditCompletion } = await import("../../src/verify/completion-audit.js");

const DIR = new URL("./fixture/", import.meta.url).pathname;
const ORIGINAL: Record<string, string> = JSON.parse(readFileSync(`${DIR}files.json`, "utf8"));
const CRITERIA = JSON.parse(readFileSync(`${DIR}criteria.json`, "utf8"));

// ── The audit's real system prompt, read as TEXT ─────────────────────────────
// SYSTEM_PROMPTS is not exported, and importing prompt-builder for one string
// is the coupling this repo keeps regretting. Reading the source is the same
// move as the BAKED_FILES drift guard.
const pbSrc = readFileSync(new URL("../../src/agents/prompt-builder.ts", import.meta.url), "utf8");
const start = pbSrc.indexOf("\n  audit: `");
if (start === -1) throw new Error("could not find the audit prompt");
const from = start + "\n  audit: `".length;
let end = from;
while (end < pbSrc.length) {
  if (pbSrc[end] === "\\") { end += 2; continue; }
  if (pbSrc[end] === "`") break;
  end += 1;
}
const AUDIT_PROMPT = pbSrc.slice(from, end);
// Exactly what prompt-builder appends for a JSON-output agent.
const SYSTEM = AUDIT_PROMPT +
  "\n\nRESPONSE FORMAT: Output valid JSON only. No prose outside the JSON structure.";

// ── A dispatcher that does only what the audit needs ─────────────────────────
let spendUsd = 0;
let calls = 0;
const dispatcher = {
  async dispatch(opts: any) {
    calls += 1;
    const r = await fetch(`${process.env["LLM_ENDPOINT_URL"]}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env["LLM_API_KEY"]}`,
      },
      body: JSON.stringify({
        model: process.env["LLM_MODEL_NAME"],
        max_tokens: 8000,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: opts.task.description },
        ],
      }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    // M2.5 rates, ap-southeast-2 — the same row token-tracker.ts carries.
    const u = j.usage ?? {};
    const costUsd = ((u.prompt_tokens ?? 0) / 1e6) * 0.31 + ((u.completion_tokens ?? 0) / 1e6) * 1.24;
    spendUsd += costUsd;
    return { content: j.choices?.[0]?.message?.content ?? "", costUsd };
  },
} as any;

// ── Mutations, each one a failure this repo has measured ─────────────────────
type Mutation = {
  id: string;
  what: string;
  expect: string[];            // criteria that SHOULD stop being proven
  apply: (f: Record<string, string>) => void;
};

const cut = (f: Record<string, string>, path: string, re: RegExp, replace = "") => {
  const before = f[path];
  if (before === undefined) throw new Error(`mutation target missing: ${path}`);
  const after = before.replace(re, replace);
  if (after === before) throw new Error(`mutation did not match in ${path}: ${re}`);
  f[path] = after;
};

const MUTATIONS: Mutation[] = [
  {
    id: "no-persistence",
    what: "strip localStorage — the app keeps notes in memory only (Finding 4)",
    expect: ["R3"],
    apply: (f) => {
      const p = "frontend/src/lib/storage.ts";
      f[p] = (f[p] ?? "").replace(/localStorage\.(getItem|setItem|removeItem)\s*\([^)]*\)/g, "undefined");
    },
  },
  {
    id: "no-cap",
    what: "delete the 50-note cap, leaving everything around it (LEDGER R8 shape)",
    expect: ["R4", "R5"],
    apply: (f) => {
      const p = "frontend/src/lib/storage.ts";
      f[p] = (f[p] ?? "").replace(/\b50\b/g, "100000");
    },
  },
  {
    id: "handler-never-attached",
    what: "keep the Escape handler defined but never attach it",
    expect: ["R8"],
    apply: (f) => {
      const p = "frontend/src/components/NoteDialog.tsx";
      f[p] = (f[p] ?? "")
        .replace(/\b(window|document)\.addEventListener\s*\(\s*["'`]keydown["'`][^)]*\)\s*;?/g, "")
        .replace(/\bonKeyDown\s*=\s*\{[^}]*\}/g, "");
    },
  },
  {
    id: "no-inline-error",
    what: "remove the conditional error branch, keep the validation (LEDGER R6 shape)",
    expect: ["R7"],
    apply: (f) => {
      const p = "frontend/src/components/NoteDialog.tsx";
      f[p] = (f[p] ?? "").replace(/\{\s*error\s*&&[\s\S]*?\)\}/g, "");
    },
  },
  {
    id: "no-sort",
    what: "remove the newest-first ordering",
    expect: ["R9"],
    apply: (f) => {
      for (const p of Object.keys(f)) {
        if (!/NotesApp|NoteList|storage/.test(p)) continue;
        f[p] = f[p]!.replace(/\.sort\s*\([\s\S]{0,200}?\)\s*(?=[;,.)\]}\n])/g, "");
      }
    },
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────
const run = async (label: string, files: Record<string, string>) => {
  const audit = await auditCompletion({
    dispatcher,
    criteria: CRITERIA,
    files,
    gates: { checkPage: "pass", checkTypes: "pass", checkTests: "pass" },
    sessionId: `probe-${label}`,
    userId: "probe",
    projectId: "probe",
    provider: "modal",
  });
  return audit;
};

const byId = (a: any) => Object.fromEntries(a.verdicts.map((v: any) => [v.id, v.status]));
const results: any[] = [];

console.log(`fixture: ${Object.keys(ORIGINAL).length} files, ${CRITERIA.length} criteria\n`);

const base = await run("baseline", { ...ORIGINAL });
const baseStatus = byId(base);
console.log(`BASELINE (unmutated)   proven=${base.proven} unverified=${base.unverified} contradicted=${base.contradicted}`);
const falseAlarms = CRITERIA.filter((c: any) => baseStatus[c.id] !== "proven");
for (const c of falseAlarms) {
  const v = base.verdicts.find((x: any) => x.id === c.id);
  console.log(`   ! ${c.id} ${baseStatus[c.id]} — ${String(v?.note ?? "").slice(0, 110)}`);
}
results.push({ label: "baseline", status: baseStatus });

for (const m of MUTATIONS) {
  const files = { ...ORIGINAL };
  try { m.apply(files); } catch (e) {
    console.log(`\n${m.id.padEnd(24)} SKIPPED — ${(e as Error).message}`);
    continue;
  }
  const a = await run(m.id, files);
  const st = byId(a);
  const caught = m.expect.filter((id) => st[id] !== "proven");
  const collateral = CRITERIA
    .filter((c: any) => !m.expect.includes(c.id))
    .filter((c: any) => st[c.id] !== "proven" && baseStatus[c.id] === "proven")
    .map((c: any) => c.id);
  console.log(`\n${m.id}`);
  console.log(`   ${m.what}`);
  console.log(`   expected to break: ${m.expect.join(", ")}`);
  console.log(`   CAUGHT:            ${caught.length ? caught.map((id) => `${id}=${st[id]}`).join(", ") : "NOTHING — the audit missed it"}`);
  if (collateral.length) console.log(`   also flagged:      ${collateral.join(", ")}`);
  results.push({ label: m.id, status: st, caught, collateral });
}

console.log(`\n${"=".repeat(60)}`);
const recallTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
const recallHit = results.filter((r) => r.caught).reduce((n, r) => n + r.caught.length, 0);
console.log(`recall:    ${recallHit} of ${recallTotal} mutated requirements flagged`);
console.log(`precision: ${CRITERIA.length - falseAlarms.length} of ${CRITERIA.length} proven on the UNMUTATED original (false alarms: ${falseAlarms.length})`);
console.log(`spend:     $${spendUsd.toFixed(4)} across ${calls} dispatches`);
writeFileSync(`${DIR}probe-results.json`, JSON.stringify(results, null, 2));
