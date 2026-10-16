/**
 * The first real deployment this product has ever made.
 *
 * WHY THIS EXISTS. `src/deploy/vercel.ts` was written on 2026-10-11, has cases,
 * and has **never executed once**. It was blocked on a connected Vercel token,
 * which arrived 2026-10-15. Everything about it — the scaffold it generates,
 * the `/api` routing assumption, the file inlining, the READY polling, the
 * smoke check — is unproven. Its own comment admits the routing is "the one
 * thing here nobody has tested".
 *
 * So this is not a feature test. It is the first time a line of that file runs.
 *
 * The app is deliberately TINY: the point is the deploy path, not the build.
 * A small app makes the build cheap, the deploy fast, and any failure
 * unambiguously the deployer's rather than the generated code's.
 *
 * It asks for deployment in the prompt because `deploy_app` is model-driven
 * and M2.5 cannot be relied on to choose a tool (2026-10-14: a build spent five
 * rounds without calling the write tool at all).
 *
 * **This creates a real project in the owner's Vercel account.** That is the
 * point, and it is why this is a probe run deliberately rather than an eval
 * task run in batches.
 *
 *   npx tsx --env-file=.env scripts/eval/deploy-probe.ts
 *
 * Afterwards, read the Railway log for:
 *   "Deploying to the user's Vercel"   — the call was attempted
 *   "[deploy]" / "Deployed:"           — what came back
 */
import { createTokenProvider } from "./auth.js";

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
  name: `deploy-probe-${Date.now().toString(36)}`,
  description: "First real run of src/deploy/vercel.ts",
  mode: "fast",
});
const projectId = created.project.id;

const started = await api<{ sessionId: string }>("POST", "/api/build/fast", {
  projectId,
  prompt:
    "Build a single-page app that shows a heading 'Deploy Probe' and a button that increments " +
    "a counter shown below it. Keep it to one file if you can — this is deliberately tiny. " +
    "When it renders correctly, call the deploy_app tool to deploy it, and report exactly what " +
    "that tool returns.",
});
console.log("session", started.sessionId, "project", projectId);

const deadline = Date.now() + 20 * 60_000;
let status: any = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  status = await api<any>("GET", `/api/build/${started.sessionId}/status`);
  process.stdout.write(`\r  ${status.status} phase=${status.phase}        `);
  if (status.status === "success" || status.status === "failed") break;
}
console.log("\nfinal:", status?.status, "| error:", status?.error ?? "none");

const o = status?.buildOutcome ?? {};
console.log("rounds", o.rounds, "cost", o.costUsd);
console.log("toolCalls:", JSON.stringify(o.toolCalls ?? {}));

const calls = (o.toolCalls ?? {}) as Record<string, number>;
console.log("\n── DID IT DEPLOY? ──");
if (!calls["deploy_app"]) {
  console.log(
    "deploy_app was NOT called. This run proves nothing about the deployer — it is a\n" +
    "failure of the model to pick the tool, not of src/deploy/vercel.ts. Read the\n" +
    "Railway log to confirm no deploy was attempted, then re-run with a blunter prompt.",
  );
} else {
  console.log(
    `deploy_app called ${calls["deploy_app"]} time(s). The deployer RAN for the first time.\n` +
    "Now read the Railway log — the tool's own result went to the model, not here:\n" +
    '  filter "Deploying to the user\'s Vercel"  → the attempt and its file count\n' +
    '  filter "Deploy"                          → the outcome, and the smoke result\n' +
    "An ok outcome requires Vercel READY **and** the URL answering, so a URL alone is\n" +
    "not success.",
  );
}
