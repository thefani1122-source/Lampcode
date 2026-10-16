/**
 * Cases for the Vercel deploy path. Run by `npm test`. Costs nothing — every
 * network call is injected.
 *
 * Two properties these protect.
 *
 * The first is that a deploy carries the WHOLE app. Deploying only the frontend
 * of a fullstack app ships a site where no data loads, which is the bug fixed on
 * 2026-10-11 arriving through a different door — so the cases assert the api
 * scaffold is actually among the uploaded files.
 *
 * The second is that `ok` is honest. Every other builder reports a deploy as
 * done the moment it has a URL. A URL only proves the API call was accepted, and
 * the one untested assumption in `vercel.ts` — whether api/[...route].ts catches
 * every /api/* path in a project that is also a Vite build — produces exactly
 * the failure where the URL is live and the app is broken. So `ok` requires
 * READY *and* a passing smoke check, and the cases pin that.
 */

import {
  detectDeployShape,
  vercelScaffold,
  projectSlug,
  toInlinedFiles,
  parseMcpJson,
  deployToVercel,
  formatDeployForUser,
} from "../src/deploy/vercel.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

// ── shape detection ──────────────────────────────────────────────────────────
// The same signals e2b-service.ts starts the backend with. If these ever
// disagree, an app boots in the preview and deploys as the wrong thing.

check("a frontend-only app is static", detectDeployShape({ "src/App.tsx": "x" }), "static");
check(
  "the Hono app file means hono",
  detectDeployShape({ "src/server/app.ts": "x", "src/App.tsx": "y" }),
  "hono",
);
check(
  "so does the starter the sandbox detects",
  detectDeployShape({ "src/server/index.ts": "x" }),
  "hono",
);
check("a FastAPI entry means fastapi", detectDeployShape({ "src/server/main.py": "x" }), "fastapi");
check(
  "python wins over a leftover ts server, matching the sandbox's own order",
  detectDeployShape({ "src/server/main.py": "x", "src/server/index.ts": "y" }),
  "fastapi",
);

// ── the scaffold ─────────────────────────────────────────────────────────────

// These two cases used to assert that a static app needs nothing added and a
// hono app gets only its api entry. Both were WRONG, and they passed for five
// days because they encoded the same mistake the code made.
//
// The first real deployment, 2026-10-16, logged `files: 1`: Vercel was handed
// `src/App.tsx` and nothing to build it with. package.json, vite.config.ts,
// index.html and tsconfig.json are BAKED_FILES — owned by the E2B template,
// never present in projectFiles or generatedFiles. Inside the sandbox that is
// invisible because the template wrote them to disk; outside it there is no
// template. A case asserting "nothing added" was pinning the bug.
const staticScaffold = vercelScaffold("static");
for (const needed of ["package.json", "vite.config.ts", "index.html", "tsconfig.json"]) {
  ok(`a static app gets ${needed}, which the template owns and never ships`, needed in staticScaffold);
}
check(
  "a hono app gets the build files AND its api entry",
  Object.keys(vercelScaffold("hono")).sort(),
  ["api/[...route].ts", "index.html", "package.json", "tsconfig.json", "vite.config.ts"],
);
check("fastapi already exposes the ASGI app Vercel wants", vercelScaffold("fastapi"), {});

// Trap 11: the template's vite.config bakes server.proxy['/api'] → localhost,
// a DEV-SERVER feature. Shipping it to Vercel would be dead config implying
// the API works. The generated app reaches its backend through VITE_API_URL.
ok(
  "the deployed vite config carries no dev proxy",
  !(staticScaffold["vite.config.ts"] ?? "").includes("proxy"),
);
ok(
  "the deployed index.html mounts the app's real entry point",
  (staticScaffold["index.html"] ?? "").includes("/src/index.tsx"),
);

// Trap 2: a generated package.json is ignored for everything EXCEPT its
// dependencies, which ARE installed. An app importing three or gsap declared
// it there, so dropping those on the way to Vercel breaks the richer apps.
const withDeps = vercelScaffold("static", {
  "package.json": JSON.stringify({ dependencies: { three: "^0.169.0", react: "18.0.0" } }),
});
const deps = JSON.parse(withDeps["package.json"] ?? "{}").dependencies as Record<string, string>;
check("a declared dependency survives to the deploy", deps["three"], "^0.169.0");
check("the app's own pin wins over the baseline", deps["react"], "18.0.0");
ok("the baseline is still there", deps["@tanstack/react-query"] !== undefined);
check(
  "a generated package.json that does not parse does not break the deploy",
  typeof vercelScaffold("static", { "package.json": "{not json" })["package.json"],
  "string",
);

// hono/vercel's own types say: "will be removed in v5. Install @hono/vercel".
// A Hono instance already exposes .fetch, which IS the shape Vercel's api/
// functions expect — so the adapter is unnecessary, and depending on it would
// also have meant a new package in the E2B template and a rebuild (trap 6).
ok(
  "the api entry does NOT use the deprecated hono/vercel adapter",
  !(vercelScaffold("hono")["api/[...route].ts"] ?? "").includes("hono/vercel"),
);
ok(
  "it default-exports the app the generator wrote",
  (vercelScaffold("hono")["api/[...route].ts"] ?? "").includes("export default app"),
);
ok(
  "and imports it from where the split put it",
  (vercelScaffold("hono")["api/[...route].ts"] ?? "").includes("src/server/app.js"),
);

// ── project slug ─────────────────────────────────────────────────────────────

check("a slug lowercases and dashes", projectSlug("My Shift Planner"), "my-shift-planner");
check("symbols collapse", projectSlug("Rota!! v2 (final)"), "rota-v2-final");
check("no leading or trailing dash", projectSlug("  --Rota--  "), "rota");
check("an unusable name still deploys", projectSlug("!!!"), "lampcode-app");
check("an empty name still deploys", projectSlug(""), "lampcode-app");
ok("a long name is capped", projectSlug("a".repeat(120)).length <= 52);
ok("and the cap cannot leave a trailing dash", !projectSlug(`${"a".repeat(51)} b`).endsWith("-"));

// ── file selection ───────────────────────────────────────────────────────────

const FILES = {
  "src/App.tsx": "app",
  "node_modules/react/index.js": "dep",
  "dist/index.html": "built",
  ".env": "SECRET=1",
  ".env.local": "SECRET=2",
  "package.json": "{}",
};

check(
  "dependencies, build output and env files are never uploaded",
  toInlinedFiles(FILES).inlined.map((f) => f.file),
  ["package.json", "src/App.tsx"],
);

// An .env in a deploy request would hand the user's secrets to a provider log.
ok(
  "no env file reaches the request",
  toInlinedFiles(FILES).inlined.every((f) => !f.file.includes(".env")),
);

check(
  "what was left out is reported, not silently dropped",
  toInlinedFiles(FILES).skipped.sort(),
  [".env", ".env.local", "dist/index.html", "node_modules/react/index.js"],
);

check(
  "files are inlined as utf-8 with their content",
  toInlinedFiles({ "a.ts": "hello" }).inlined,
  [{ file: "a.ts", data: "hello", encoding: "utf-8" }],
);

// ── MCP text results ─────────────────────────────────────────────────────────

check("plain json parses", parseMcpJson('{"id":"dpl_1"}')?.["id"], "dpl_1");
check(
  "json wrapped in prose parses",
  parseMcpJson('Created the deployment:\n{"id":"dpl_2","url":"x.vercel.app"}\nDone.')?.["id"],
  "dpl_2",
);
check("garbage yields null, not a throw", parseMcpJson("no json here"), null);
check("empty yields null", parseMcpJson(""), null);

// ── the deploy itself ────────────────────────────────────────────────────────

const AUTH = { accessToken: "tok" };
const APP = { "src/App.tsx": "x", "src/server/app.ts": "y", "src/server/index.ts": "z" };
const noSleep = async () => {};
const smokeOk = async (url: string) => ({
  url,
  ok: true,
  checks: [{ name: "Homepage", passed: true, latencyMs: 1 }],
  totalLatencyMs: 1,
});
const smokeBad = async (url: string) => ({
  url,
  ok: false,
  checks: [
    { name: "Homepage", passed: true, latencyMs: 1 },
    { name: "API", passed: false, latencyMs: 2 },
  ],
  totalLatencyMs: 3,
});

/** Records what was sent, and answers like the Vercel MCP would. */
function fakeCall(opts: { state?: string; url?: string; failCreate?: boolean } = {}) {
  const sent: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call = async (
    target: { mcpToolName: string },
    args: Record<string, unknown>,
  ): Promise<string> => {
    sent.push({ tool: target.mcpToolName, args });
    if (target.mcpToolName === "create_deployment") {
      if (opts.failCreate) throw new Error("403 forbidden");
      return JSON.stringify({ id: "dpl_1", url: opts.url ?? "rota.vercel.app" });
    }
    return JSON.stringify({
      readyState: opts.state ?? "READY",
      url: opts.url ?? "rota.vercel.app",
    });
  };
  return { call, sent };
}

{
  const { call, sent } = fakeCall();
  const out = await deployToVercel({
    auth: AUTH, files: APP, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep, maxWaitMs: 1000,
  });
  check("a healthy deploy is ok, with the url", [out.ok, out.url], [true, "https://rota.vercel.app"]);
  check("and reports the shape it deployed as", out.shape, "hono");

  const created = sent.find((s) => s.tool === "create_deployment");
  const body = created?.args["requestBody"] as Record<string, unknown>;
  const uploaded = (body["files"] as Array<{ file: string }>).map((f) => f.file);

  // The whole point: a fullstack deploy that omits the api entry is a site
  // where no data loads.
  ok("the api scaffold is uploaded with the app", uploaded.includes("api/[...route].ts"));
  ok("alongside the app's own server file", uploaded.includes("src/server/app.ts"));
  check("the project name is slugged", body["name"], "rota");
  check("it targets production, not a preview URL", body["target"], "production");
  check("a vite app uses the vite preset", (body["projectSettings"] as Record<string, unknown>)["framework"], "vite");

  // Without this Vercel returns 400 asking a human to confirm the framework,
  // which no automated deploy can answer.
  check(
    "framework-detection confirmation is skipped",
    created?.args["skipAutoDetectionConfirmation"],
    "1",
  );
}

{
  const { call } = fakeCall({ failCreate: true });
  const out = await deployToVercel({
    auth: AUTH, files: APP, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep, maxWaitMs: 1000,
  });
  check("a refused deploy is not ok and has no url", [out.ok, out.url], [false, undefined]);
  ok("and says what Vercel said", (out.error ?? "").includes("403"));
}

{
  const { call } = fakeCall({ state: "ERROR" });
  const out = await deployToVercel({
    auth: AUTH, files: APP, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep, maxWaitMs: 1000,
  });
  check("a failed build is not ok", out.ok, false);
  check("and the state is reported", out.state, "ERROR");
}

// The case this whole file exists for: Vercel says READY, the URL is live, and
// the app does not work. Reporting that as success is what every other builder
// does.
{
  const { call } = fakeCall();
  const out = await deployToVercel({
    auth: AUTH, files: APP, projectName: "Rota",
    call: call as never, smoke: smokeBad as never, sleep: noSleep, maxWaitMs: 1000,
  });
  check("READY plus a failing smoke check is NOT ok", out.ok, false);
  ok("but the url is still reported, because it exists", out.url === "https://rota.vercel.app");
  ok("and the failure is named", (out.error ?? "").includes("did not answer"));
}

{
  const { call } = fakeCall({ state: "BUILDING" });
  const out = await deployToVercel({
    auth: AUTH, files: APP, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep, maxWaitMs: 1,
  });
  check("a build still running when time runs out is not ok", out.ok, false);
  // Not "finished with state BUILDING", which is a contradiction and would tell
  // a user their slow build had broken. Only a terminal state is a verdict.
  ok("and says it may still be building", (out.error ?? "").includes("still be building"));
  ok("it does not claim the build finished", !(out.error ?? "").includes("finished"));
}

{
  const { call } = fakeCall();
  const out = await deployToVercel({
    auth: AUTH, files: {}, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep,
  });
  check("an empty project is refused before any call", [out.ok, out.shape], [false, "static"]);
}

// A static app must not get the api scaffold — there is no server to serve.
{
  const { call, sent } = fakeCall();
  await deployToVercel({
    auth: AUTH, files: { "src/App.tsx": "x" }, projectName: "Rota",
    call: call as never, smoke: smokeOk as never, sleep: noSleep, maxWaitMs: 1000,
  });
  const body = sent[0]?.args["requestBody"] as Record<string, unknown>;
  const uploaded = (body["files"] as Array<{ file: string }>).map((f) => f.file);
  ok("a frontend-only app gets no api entry", !uploaded.some((f) => f.startsWith("api/")));
}

// ── what the user is told ────────────────────────────────────────────────────

check(
  "a live app is one line with the link",
  formatDeployForUser({ ok: true, url: "https://x.vercel.app", shape: "hono" }),
  ["It's live on your Vercel: https://x.vercel.app"],
);

check(
  "a half-working deploy says so, and names what didn't answer",
  formatDeployForUser({
    ok: false,
    url: "https://x.vercel.app",
    shape: "hono",
    smoke: {
      url: "https://x.vercel.app",
      ok: false,
      checks: [
        { name: "Homepage", passed: true, latencyMs: 1 },
        { name: "API", passed: false, latencyMs: 2 },
      ],
      totalLatencyMs: 3,
    },
  }),
  [
    "It deployed to https://x.vercel.app, but it isn't answering properly yet.",
    "What didn't respond: API.",
    "The build succeeded, so this is about how the deployed app is wired rather than the code itself. Tell me and I'll look.",
  ],
);

check(
  "a failed deploy reassures that nothing was changed",
  formatDeployForUser({ ok: false, shape: "hono", error: "Vercel refused it." }),
  ["Vercel refused it.", "Nothing was changed in your project. Tell me and I'll try again."],
);

ok(
  "no user-facing line leaks the token or a file path",
  [
    ...formatDeployForUser({ ok: true, url: "https://x.vercel.app", shape: "hono" }),
    ...formatDeployForUser({ ok: false, shape: "hono", error: "nope" }),
  ].every((l) => !l.includes("tok") && !l.includes("src/")),
);

console.log(failures === 0 ? "\nAll deploy cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
