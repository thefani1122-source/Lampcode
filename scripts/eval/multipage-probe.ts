/**
 * One real multi-page build, to see the page sweep do the thing it was built
 * for.
 *
 * WHY THIS EXISTS. check_page opened `/` and nothing else, so every page after
 * the first was unobserved — which is the owner's standing complaint about
 * multi-page apps whose pages do nothing, and it was literally true of the
 * harness. The sweep that replaced it is measured against fixtures and against
 * a hand-built four-page site, but neither proves it runs inside a real
 * sandbox against a real generated app with real routes.
 *
 * The notes-app probe next door cannot show this: it generates ONE page, so a
 * sweep over it and the old single-route check are indistinguishable.
 *
 * What to look for afterwards, in the Railway log:
 *
 *     [tools] check_page routes=N broken=… repeat=false chars=…
 *     [tools] check_page routes=N broken=… repeat=true  chars=…   ← the diff
 *
 * routes>1 is the whole claim. A second line with repeat=true and a much
 * smaller chars is the cost claim.
 *
 * A probe, not a scorer: it prints what it found and leaves the judgement to a
 * person. It spends real money — one build.
 *
 *   npx tsx --env-file=.env scripts/eval/multipage-probe.ts
 *
 * Deliberately NOT an eval task. Adding one to tasks.ts is the better fix and
 * the right one before this path ships again; it is kept separate so no stored
 * run becomes incomparable.
 */
import { createTokenProvider } from "./auth.js";
import { declaredRoutes } from "../../src/verify/wiring.js";
import { routesToVisit } from "../../src/verify/render.js";

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
  name: `multipage-check-${Date.now().toString(36)}`,
  description: "Verifying the multi-route page sweep on a real build",
  mode: "fast",
});
const projectId = created.project.id;

const started = await api<{ sessionId: string }>("POST", "/api/build/fast", {
  projectId,
  prompt:
    "Build a small recipe site with react-router-dom and FOUR separate pages, each at its own " +
    "route: / shows a list of recipes, /recipes/new has a form to add one, /favourites lists " +
    "saved ones, and /about is a short page about the site. Put a nav bar with links to all " +
    "four on every page. Keep the data in React state — no backend.",
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
console.log("checkPage:", o.checkPage, "| checkTypes:", o.checkTypes, "| checkTests:", o.checkTests);
console.log("toolCalls:", JSON.stringify(o.toolCalls ?? {}));
console.log("wiring  :", JSON.stringify(o.wiring ?? null));
console.log("preview url:", status?.previewUrl ?? "(none)");

// Paths come back relative to the WORKSPACE root, so they carry the output
// directory as a leading segment. Project-relative is what everything else
// here speaks. (Second time that tripped a probe up; see the hono probe.)
const fj = await api<any>("GET", `/api/build/${started.sessionId}/files`);
const files: Record<string, string> = {};
for (const [, arr] of Object.entries(fj.groups ?? {})) {
  for (const f of arr as Array<{ path: string; content: unknown }>) {
    if (typeof f.content === "string") files[f.path.replace(/^(?:frontend|backend)\//, "")] = f.content;
  }
}
console.log("\nfiles:", Object.keys(files).length);
for (const p of Object.keys(files).sort()) console.log("   ", p);

const declared = new Set<string>();
for (const code of Object.values(files)) for (const r of declaredRoutes(code)) declared.add(r);
const shouldHaveVisited = routesToVisit([...declared]);

console.log("\n── WHAT THE SWEEP SHOULD HAVE SEEN ──");
console.log("routes declared by the generated app:", [...declared].join(", ") || "(none)");
console.log("routes the sweep would visit        :", shouldHaveVisited.join(", "));
console.log(
  shouldHaveVisited.length > 1
    ? `\nSo the Railway log should read routes=${shouldHaveVisited.length}. If it reads routes=1,\n` +
      `the sweep is not deriving routes from the project and the change did nothing.`
    : `\nThis build declared no extra routes, so this run CANNOT prove the sweep works.\n` +
      `Do not read a routes=1 log line as a failure of the sweep — it is a failure of\n` +
      `this probe to produce a multi-page app.`,
);
