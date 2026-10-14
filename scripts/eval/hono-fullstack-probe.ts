/**
 * One real Hono fullstack build, and the checks the eval set cannot make.
 *
 * WHY THIS EXISTS. The twenty eval tasks contain exactly one backend task,
 * `python-api`, and it is FastAPI. Nothing in the set generates a Hono/Node
 * backend — which is the DEFAULT fullstack path, and the one the 2026-10-11
 * `src/server/app.ts` split changed. So the riskiest change of that week was
 * covered by no eval at all, and the four smoke tasks (counter, todo,
 * pricing-page, form-validation) are frontend-only and never touch it.
 *
 * This drives one build through the same HTTP API the harness uses, then
 * asserts the shape the prompt now asks for: `app.ts` builds and
 * default-exports the app and does NOT listen, `index.ts` imports it and calls
 * serve(), and the preview still comes up. It also runs the wiring analyser
 * over the real generated files, which is the only way to see that analyser
 * against a backend rather than a fixture.
 *
 * It is a probe, not a scorer: it prints what it found and leaves the judgement
 * to a person. It spends real money — one build.
 *
 *   npx tsx --env-file=.env scripts/eval/hono-fullstack-probe.ts
 *
 * The prompt here is deliberately NOT an eval task. Adding it to `tasks.ts`
 * would be the better fix, and the right one before this path ships again; it
 * is kept separate for now so no stored run becomes incomparable.
 */
import { createTokenProvider } from "./auth.js";
import { findWiringGaps, tallyWiringGaps } from "../../src/verify/wiring.js";

const base = process.env["EVAL_BASE_URL"]!;
const tp = createTokenProvider(process.env);
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tp.token()}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

const created = await api<{ project: { id: string } }>("POST", "/api/projects", {
  name: `hono-split-check-${Date.now().toString(36)}`,
  description: "Verifying the src/server/app.ts split on a real Hono build",
  mode: "fast",
});
const projectId = created.project.id;
const started = await api<{ sessionId: string }>("POST", "/api/build/fast", {
  projectId,
  prompt:
    "Build a notes app with a real Hono backend API on the server: GET /api/notes to list, " +
    "POST /api/notes to create, DELETE /api/notes/:id to remove. The React frontend calls " +
    "those endpoints. Keep it simple.",
});
console.log("session", started.sessionId, "project", projectId);

const deadline = Date.now() + 15 * 60_000;
let status: any = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  status = await api<any>("GET", `/api/build/${started.sessionId}/status`);
  process.stdout.write(`\r  ${status.status} phase=${status.phase}        `);
  if (status.status === "success" || status.status === "failed") break;
}
console.log("\nfinal:", status?.status, "| error:", status?.error ?? "none");
const o = status?.buildOutcome ?? {};
console.log("rounds", o.rounds, "cost", o.costUsd, "turnsExhausted", o.turnsExhausted);
console.log("wiring  :", JSON.stringify(o.wiring ?? null));
console.log("deadCode:", JSON.stringify(o.deadCode ?? null));

// The endpoint answers { totalFiles, groups: { "<dir>": [{path, content}] } }.
// Reading it as { files: [...] } silently yields zero files and makes every
// check below report MISSING — which is exactly how this probe first claimed
// the split had failed on a build that was in fact correct.
const fj = await api<any>("GET", `/api/build/${started.sessionId}/files`);
const files: Record<string, string> = {};
for (const [, arr] of Object.entries(fj.groups ?? {})) {
  for (const f of arr as Array<{ path: string; content: unknown }>) {
    if (typeof f.content === "string") files[f.path] = f.content;
  }
}
if (Object.keys(files).length === 0) {
  console.log("\nNO FILES READ — the checks below prove nothing. Fix the fetch, not the build.");
}
console.log("\nfiles:", Object.keys(files).length);
for (const p of Object.keys(files).sort()) console.log("   ", p);

console.log("\n── THE SPLIT ──");
console.log("src/server/app.ts  :", "src/server/app.ts" in files ? "PRESENT" : "MISSING");
console.log("src/server/index.ts:", "src/server/index.ts" in files ? "PRESENT" : "MISSING");
const idx = files["src/server/index.ts"] ?? "";
const app = files["src/server/app.ts"] ?? "";
console.log("index.ts imports app:", /from\s+['\"]\.\/app\.js['\"]/.test(idx) ? "yes" : "NO");
console.log("index.ts serves     :", /serve\(/.test(idx) ? "yes" : "NO");
console.log("app.ts default-export:", /export\s+default\s+app/.test(app) ? "yes" : "NO");
console.log("app.ts does NOT listen:", /serve\(/.test(app) ? "NO — it calls serve()" : "correct");
console.log("preview url:", status?.previewUrl ?? "(none)");

// The other change that only a real fullstack build can exercise: a generated
// frontend must reach its backend through API_BASE, never a hardcoded dev host,
// or the app works in the preview and nowhere else.
const apiLib = files["src/lib/api.ts"] ?? "";
console.log("\n── API_BASE ──");
console.log("src/lib/api.ts      :", apiLib ? "PRESENT" : "MISSING");
console.log("uses VITE_API_URL   :", /VITE_API_URL/.test(apiLib) ? "yes" : "NO");
console.log("hardcodes localhost :", /localhost|127\.0\.0\.1/.test(apiLib) ? "YES — bad" : "no");
console.log("\nlocal wiring on the real files:", JSON.stringify(tallyWiringGaps(findWiringGaps(files))));
