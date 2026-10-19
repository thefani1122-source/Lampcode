/**
 * One real fullstack build, one follow-up edit, and the evidence from both.
 *
 * Written for the launch-proof pass rather than added to the eval set, on
 * purpose: the eval's stored tasks must never change (it would make every
 * recorded run incomparable), none of them is a fullstack app with auth, and
 * the harness has no notion of a second message to the same project. This
 * drives the same HTTP path the frontend does — sign in, create a project,
 * POST /api/build/fast, poll, then POST again to the same project — and prints
 * what the record holds afterwards.
 *
 * It spends real money: two builds' worth of model tokens and an E2B sandbox.
 *
 *   EVAL_EMAIL=… EVAL_PASSWORD=… EVAL_SUPABASE_ANON_KEY=… \
 *   EVAL_BASE_URL=https://… npx tsx scripts/launch-proof.ts
 */

import { createTokenProvider } from "./eval/auth.js";

const BASE_URL = (process.env["EVAL_BASE_URL"] ?? "").replace(/\/$/, "");
if (!BASE_URL) throw new Error("EVAL_BASE_URL is required");

const auth = createTokenProvider(process.env);

/** The build this pass is meant to prove: frontend, backend, persistence,
 *  user-scoped data, several routes and controls. */
const PROMPT =
  "Build a team expense tracker. A person signs in, submits an expense claim with an amount, " +
  "a category and a note, and sees only their own claims in a table they can filter by " +
  "category. A separate approvals page lists claims awaiting a decision with approve and " +
  "reject buttons, and nobody may approve their own claim. Claims persist in the database so " +
  "they survive a reload, and the dashboard shows totals by category.";

/** The edit, sent to the same project after the first build finishes. */
const EDIT =
  "Add a status filter to the claims table — all, pending, approved, rejected — and show each " +
  "claim's submitted date in the table.";

const POLL_MS = 10_000;

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await auth.token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Status = {
  status?: string;
  buildOutcome?: Record<string, unknown> | null;
  error?: string | null;
};

async function runOne(label: string, projectId: string, prompt: string, timeoutSec: number): Promise<void> {
  console.log(`\n── ${label} ──────────────────────────────────────────`);
  const started = await api<{ sessionId: string }>("POST", "/api/build/fast", { projectId, prompt });
  console.log(`session ${started.sessionId}`);

  const deadline = Date.now() + timeoutSec * 1_000;
  let last: Status | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      last = await api<Status>("GET", `/api/build/${started.sessionId}/status`);
    } catch (err) {
      console.log(`  (status read failed: ${err instanceof Error ? err.message.slice(0, 120) : err})`);
      continue;
    }
    const elapsed = Math.round((timeoutSec * 1_000 - (deadline - Date.now())) / 1000);
    console.log(`  ${elapsed}s status=${last.status}`);
    if (last.status === "success" || last.status === "failed") break;
  }

  console.log(`\n${label} final status: ${last?.status ?? "unknown"}`);
  if (last?.error) console.log(`error: ${last.error}`);
  if (last?.buildOutcome) {
    console.log("build_outcome:");
    console.log(JSON.stringify(last.buildOutcome, null, 2));
  } else {
    console.log("build_outcome: absent");
  }
  console.log(`session id for the event stream: ${started.sessionId}`);
}

const project = await api<{ project: { id: string } }>("POST", "/api/projects", {
  name: `launch-proof-${Date.now().toString(36)}`,
  description: "Launch-proof pass: one fullstack build plus one edit",
  mode: "fast",
});
console.log(`project ${project.project.id}`);

await runOne("BUILD 1 — fullstack", project.project.id, PROMPT, 1200);
await runOne("BUILD 2 — follow-up edit", project.project.id, EDIT, 900);

console.log("\nDone. Both sessions' events are in build_events, ordered by seq.");
