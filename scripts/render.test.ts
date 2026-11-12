/** Cases for the multi-route render check. Run by `npm test`.
 *
 * The two that matter most are the ones about SILENCE: a report that cannot be
 * parsed must never read as a pass, and a page that renders nothing must not be
 * reported as working. Both are the failure this module exists to end — the old
 * check answered "did it crash" and a quiet crash-free empty page was its blind
 * spot, which is what shipped ROTA. */
import { readFileSync } from "node:fs";
import {
  routesToVisit,
  parseRenderReport,
  allRoutesOk,
  formatRenderForAgent,
  MAX_TEXT_CHARS,
  RENDER_SCRIPT,
  INITIAL_EMPTY_STATE_RE,
  shouldRequireInitialContent,
  shouldRequireCollectionSurface,
  shouldRequireCoreJourney,
} from "../src/verify/render.js";
import type { RenderReport, RouteRender } from "../src/verify/render.js";

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

const line = (o: unknown) => `LAMPCODE_RENDER:${JSON.stringify(o)}`;

// ── routesToVisit ────────────────────────────────────────────────────────────

check("root is always visited, even with nothing declared", routesToVisit([]), ["/"]);
check("root is first and not duplicated", routesToVisit(["/shifts", "/"]), ["/", "/shifts"]);
check(
  "declared routes are visited",
  routesToVisit(["/shifts", "/staff", "/rules"]),
  ["/", "/shifts", "/staff", "/rules"],
);
// Visiting /shift/:id literally lands on a record that does not exist and
// reports its empty state as a failure — a false accusation against working code.
check("parameterised routes are skipped, not guessed", routesToVisit(["/shift/:id"]), ["/"]);
check("wildcards are skipped", routesToVisit(["/docs/*"]), ["/"]);
check("non-absolute paths are ignored", routesToVisit(["shifts", "../x"]), ["/"]);

// ── first-run empty-state vocabulary ─────────────────────────────────────────

for (const phrase of [
  "No habits yet",
  "No tasks yet",
  "No items yet",
  "Create your first habit",
  "Add your first task",
  "Nothing to show yet",
]) {
  ok(`detects first-run empty-state copy: ${phrase}`, INITIAL_EMPTY_STATE_RE.test(phrase));
}
ok(
  "does not classify a populated screen as empty",
  !INITIAL_EMPTY_STATE_RE.test("Good morning. You completed 3 of 5 habits today."),
);
ok(
  "does not confuse a real collection heading with an empty state",
  !INITIAL_EMPTY_STATE_RE.test("Habit Tracker • 5 active habits"),
);

// ── parsing ──────────────────────────────────────────────────────────────────

// Nothing parseable must be "could not check", never a pass. The caller
// distinguishes null from an all-ok report; collapsing them is how an agent
// reports verifying a page the browser never opened.
check("unparseable output is null, not an empty pass", parseRenderReport("npm warn whatever"), null);
check("empty output is null", parseRenderReport(""), null);
check("a marker with broken JSON is null", parseRenderReport("LAMPCODE_RENDER:{oops"), null);

// npm and node print freely in a sandbox, before AND after. The old check read
// the last line, so one trailing warning made a working page unverifiable.
const noisy = `npm warn exec\n${line({ routes: [{ route: "/", blank: false, errors: [], text: "Hi" }], unreachable: [] })}\n(node:42) warning`;
check("the marked line is found among noise on both sides", parseRenderReport(noisy)?.routes[0]?.route, "/");

const clean = parseRenderReport(
  line({ routes: [{ route: "/", blank: false, errors: [], text: "Shift Planner" }], unreachable: [] }),
);
ok("a quiet page is ok", clean?.routes[0]?.ok === true);
ok("allRoutesOk agrees", allRoutesOk(clean!));

// HMR noise is about the sandbox, not the app. Left in, it made this gate fail
// pages that rendered fine and invited the model to edit working code.
const hmr = parseRenderReport(
  line({
    routes: [{
      route: "/",
      blank: false,
      text: "Hi",
      errors: [
        "WebSocket connection to 'ws://localhost:5173/' failed",
        "[vite] failed to connect to websocket",
        "Error: WebSocket closed without opened.",
      ],
    }],
    unreachable: [],
  }),
);
check("HMR websocket noise is dropped", hmr?.routes[0]?.errors, []);
ok("a page with only HMR noise is ok", hmr?.routes[0]?.ok === true);

// An app's own websocket failure is a real bug and must survive the filter.
const realWs = parseRenderReport(
  line({
    routes: [{ route: "/", blank: false, text: "Hi", errors: ["WebSocket connection to 'wss://api.example.com/live' failed"] }],
    unreachable: [],
  }),
);
check("a real backend websocket error is kept", realWs?.routes[0]?.errors.length, 1);
ok("and the route is not ok", realWs?.routes[0]?.ok === false);

// Found by running the real script against a real page: a missing favicon
// produced a console error AND a 404 response, which between them would have
// marked every page of every generated app as broken. Generated apps almost
// never ship a favicon.
const favicon = parseRenderReport(line({
  routes: [{
    route: "/",
    blank: false,
    text: "Planner",
    errors: ["Failed to load resource: the server responded with a status of 404 (File not found)"],
    failedRequests: [{ url: "http://localhost:5173/favicon.ico", status: 404 }],
  }],
  unreachable: [],
}));
check("the generic resource console line is dropped", favicon?.routes[0]?.errors, []);
check("a missing favicon is not a failed request", favicon?.routes[0]?.failedRequests, []);
ok("a page is not broken just for lacking a favicon", favicon?.routes[0]?.ok === true);

for (const asset of ["/apple-touch-icon.png", "/site.webmanifest", "/manifest.json", "/robots.txt"]) {
  const r = parseRenderReport(line({
    routes: [{ route: "/", blank: false, errors: [], text: "x", failedRequests: [{ url: `http://h${asset}`, status: 404 }] }],
    unreachable: [],
  }));
  ok(`${asset} missing is cosmetic`, r?.routes[0]?.ok === true);
}

// The point of watching responses at all: in a generated app, a request its own
// backend refuses IS the feature not working.
const api = parseRenderReport(line({
  routes: [{
    route: "/shifts",
    blank: false,
    text: "Shifts",
    errors: [],
    failedRequests: [{ url: "http://localhost:5173/api/shifts", status: 500 }],
  }],
  unreachable: [],
}));
ok("a failing API call makes the route not ok", api?.routes[0]?.ok === false);
const apiOut = formatRenderForAgent(api!);
ok("the failing path and status are both named", apiOut.includes("/api/shifts returned 500"));
ok("the sandbox host is not carried back", !apiOut.includes("localhost:5173"));

const blank = parseRenderReport(line({ routes: [{ route: "/x", blank: true, errors: [], text: "" }], unreachable: [] }));
ok("a blank page is not ok", blank?.routes[0]?.ok === false);
ok("allRoutesOk is false when one route is blank", allRoutesOk(blank!) === false);

const emptyFirstRun = parseRenderReport(line({
  routes: [{
    route: "/",
    blank: false,
    errors: [],
    text: "Habit Tracker Add Habit No habits yet Create your first habit",
    emptyState: "No habits yet",
  }],
  unreachable: [],
}));
ok("a visible first-run empty state is not a page pass", emptyFirstRun?.routes[0]?.ok === false);
ok("the empty-state copy survives parsing", emptyFirstRun?.routes[0]?.emptyState === "No habits yet");
ok("allRoutesOk rejects the empty first-run screen", allRoutesOk(emptyFirstRun!) === false);
ok(
  "the model is told to populate the empty first-run screen",
  formatRenderForAgent(emptyFirstRun!).includes("initial empty state") &&
    formatRenderForAgent(emptyFirstRun!).includes("No habits yet"),
);

const shellOnly = parseRenderReport(line({
  routes: [{
    route: "/",
    blank: false,
    errors: [],
    text: "Habit Tracker New Habit",
    contentIssue: "The collection product is only a shell: the primary workspace has 34 text characters, 0 semantic content blocks, 0 meaningful content groups, and 1 heading. Build the actual dashboard/list/table/progress surface and a useful empty-data state. Do not invent rows in a real database.",
  }],
  unreachable: [],
}));
ok("a heading and one primary button are not a complete collection workspace", shellOnly?.routes[0]?.ok === false);
ok("the exact collection-surface issue survives report parsing", shellOnly?.routes[0]?.contentIssue?.includes("only a shell") === true);
ok("the agent receives an actionable collection-surface defect", formatRenderForAgent(shellOnly!).includes("Build the actual dashboard/list/table/progress surface"));
ok("an intentionally structured empty database page can pass the surface gate", parseRenderReport(line({
  routes: [{ route: "/", blank: false, errors: [], text: "Habit Tracker Active habits 0 Weekly progress No habits yet Add a habit" }],
  unreachable: [],
}))?.routes[0]?.ok === true);

const overlay = parseRenderReport(
  line({ routes: [{ route: "/", blank: false, errors: [], text: "", overlay: "Failed to resolve import ./Foo" }], unreachable: [] }),
);
ok("a Vite overlay is not ok", overlay?.routes[0]?.ok === false);

const authLayoutReport = parseRenderReport(line({
  routes: [{
    route: "/login",
    blank: false,
    errors: [],
    text: "Sign in",
    layout: {
      desktop: { width: 1440, height: 900, scrollWidth: 1440, horizontalOverflow: 0, mainCount: 1, navCount: 0, asideCount: 0, headingCount: 1, passwordFormWidth: 900, bodyFontFamily: "Inter", bodyBackground: "rgb(248, 250, 252)" },
      mobile: { width: 390, height: 844, scrollWidth: 412, horizontalOverflow: 22, mainCount: 1, navCount: 0, asideCount: 0, headingCount: 1, passwordFormWidth: 390, bodyFontFamily: "Inter", bodyBackground: "rgb(248, 250, 252)" },
    },
  }],
  unreachable: [],
}))!;
ok("a stretched desktop login form fails the layout gate", authLayoutReport.routes[0]?.ok === false);
ok("mobile horizontal overflow fails the layout gate", authLayoutReport.routes[0]?.layoutIssues?.some((x) => x.includes("overflows horizontally")) === true);
ok("a full-width desktop password form is specifically identified", authLayoutReport.routes[0]?.layoutIssues?.some((x) => x.includes("authentication form is too wide")) === true);
ok("mobile form edge-to-edge layout is specifically identified", authLayoutReport.routes[0]?.layoutIssues?.some((x) => x.includes("safe mobile side margin")) === true);
ok("layout findings are passed back to the agent", formatRenderForAgent(authLayoutReport).includes("UI FIX REQUIRED"));

const goodAuthLayout = parseRenderReport(line({
  routes: [{
    route: "/login", blank: false, errors: [], text: "Sign in",
    layout: {
      desktop: { width: 1440, height: 900, scrollWidth: 1440, horizontalOverflow: 0, mainCount: 1, navCount: 0, asideCount: 0, headingCount: 1, passwordFormWidth: 440, bodyFontFamily: "Inter", bodyBackground: "rgb(248, 250, 252)" },
      mobile: { width: 390, height: 844, scrollWidth: 390, horizontalOverflow: 0, mainCount: 1, navCount: 0, asideCount: 0, headingCount: 1, passwordFormWidth: 358, bodyFontFamily: "Inter", bodyBackground: "rgb(248, 250, 252)" },
    },
  }],
  unreachable: [],
}))!;
ok("a constrained card-based login layout passes objective checks", goodAuthLayout.routes[0]?.ok === true);

check("text is capped", parseRenderReport(
  line({ routes: [{ route: "/", blank: false, errors: [], text: "x".repeat(5000) }], unreachable: [] }),
)?.routes[0]?.text.length, MAX_TEXT_CHARS);

check("a route entry with no route name is dropped", parseRenderReport(
  line({ routes: [{ blank: false, errors: [], text: "x" }], unreachable: [] }),
)?.routes.length, 0);

// ── what the model is told ───────────────────────────────────────────────────

const report = parseRenderReport(line({
  routes: [
    { route: "/", blank: false, errors: [], text: "Shift Planner No shifts scheduled" },
    { route: "/shifts", blank: true, errors: [], text: "" },
    { route: "/staff", blank: false, errors: ["TypeError: x.map is not a function"], text: "Staff" },
  ],
  unreachable: ["/rules"],
}))!;
const out = formatRenderForAgent(report);

ok("broken routes are named", out.includes("/shifts") && out.includes("/staff"));
ok("a blank page is described as rendering nothing", out.includes("renders NOTHING"));
ok("the console error is quoted", out.includes("x.map is not a function"));
ok("an unopenable route is reported as unverified, not as working", out.includes("do not treat them as working"));
ok("the working route's text is carried back", out.includes("No shifts scheduled"));
// ROTA: every gate passed while the app showed an empty state. The text is the
// only signal that catches that, so a clean run must still point at it.
const allGood = formatRenderForAgent(parseRenderReport(line({
  routes: [{ route: "/", blank: false, errors: [], text: "Shift Planner No shifts scheduled" }],
  unreachable: [],
}))!);
ok("a clean run still tells the model to read the text", allGood.includes("does each page actually show"));
ok("a clean run does not claim pages are broken", !allGood.includes("broken"));

// A page can render with no text at all — structurally fine, visibly empty.
const silent = formatRenderForAgent(parseRenderReport(line({
  routes: [{ route: "/", blank: false, errors: [], text: "" }],
  unreachable: [],
}))!);
ok("a route with no text says so explicitly", silent.includes("NO text on it at all"));

check("nothing checked says so", formatRenderForAgent({ routes: [], unreachable: [] }), "No routes could be checked.");

// ── the diff, which is what makes repeat checks affordable ───────────────────

const mk = (routes: Array<Partial<RouteRender> & { route: string }>): RenderReport =>
  parseRenderReport(line({
    routes: routes.map((r) => ({
      route: r.route,
      blank: r.blank ?? false,
      errors: r.errors ?? [],
      text: r.text ?? "",
      failedRequests: r.failedRequests ?? [],
      ...(r.overlay ? { overlay: r.overlay } : {}),
    })),
    unreachable: [],
  }))!;

const twoGood = mk([{ route: "/", text: "Home" }, { route: "/shifts", text: "Shifts" }]);

// The whole point: a second sweep over an unchanged app costs almost nothing.
const unchanged = formatRenderForAgent(twoGood, twoGood);
check("an unchanged re-check is one short line", unchanged, "No change since the last check — all 2 page(s) still render, with the same content.");
ok("and it is far shorter than the full report", unchanged.length < formatRenderForAgent(twoGood).length);

const broke = mk([{ route: "/", text: "Home" }, { route: "/shifts", blank: true }]);
const d1 = formatRenderForAgent(broke, twoGood);
ok("a newly broken page is called out", d1.includes("/shifts BROKE"));
ok("the unchanged page is not repeated", !d1.includes("/ — \"Home\""));

const d2 = formatRenderForAgent(twoGood, broke);
ok("a fixed page is reported", d2.includes("/shifts is fixed"));

// Silence about a known failure reads as "fixed" to a model that has forgotten
// it. This is the fail-closed rule of the diff.
const d3 = formatRenderForAgent(broke, broke);
ok("a still-broken page is ALWAYS restated", d3.includes("/shifts is STILL broken"));
ok("and it is not reported as unchanged-and-fine", !d3.includes("still render, with the same content"));

// How the model learns its edit reached the screen at all.
const textChanged = mk([{ route: "/", text: "Home" }, { route: "/shifts", text: "Monday Tuesday" }]);
ok("changed text on a working page is shown", formatRenderForAgent(textChanged, twoGood).includes("Monday Tuesday"));

const added = mk([{ route: "/", text: "Home" }, { route: "/shifts", text: "Shifts" }, { route: "/staff", text: "Staff" }]);
ok("a newly declared route is reported", formatRenderForAgent(added, twoGood).includes("/staff is new"));
ok("a removed route is reported", formatRenderForAgent(twoGood, added).includes("no longer declared: /staff"));

// ── first-run content policy, shared by both verification passes ──────────────

const frontendPolicy = {
  agentType: "frontend",
  taskDescription: "Build a habit tracker",
  userPrompt: "Build a habit tracker",
};
ok("a plain frontend first run must contain initial content", shouldRequireInitialContent(frontendPolicy));
ok("a non-frontend agent has no first-run content requirement", !shouldRequireInitialContent({ ...frontendPolicy, agentType: "backend" }));
ok("a full-stack build is not forced to contain seeded browser data", !shouldRequireInitialContent({ ...frontendPolicy, taskDescription: "FULLSTACK BUILD: habit tracker" }));
ok("an existing backend project is not forced to contain seeded content", !shouldRequireInitialContent({ ...frontendPolicy, projectFiles: { "src/server/index.ts": "export {}" } }));
ok("an explicit empty first run is respected", !shouldRequireInitialContent({ ...frontendPolicy, userPrompt: "Start with an empty first run; no sample data." }));

ok("a full-stack tracker still needs a substantial workspace", shouldRequireCollectionSurface({
  ...frontendPolicy,
  taskDescription: "FULLSTACK BUILD: Build a habit tracker",
}));
ok("an explicit no-sample-data request still needs real dashboard structure", shouldRequireCollectionSurface({
  ...frontendPolicy,
  userPrompt: "Build a habit tracker with no sample data on first launch",
}));
ok("login-only apps do not get collection workspace requirements", !shouldRequireCollectionSurface({
  ...frontendPolicy,
  userPrompt: "Build a login and registration page",
}));
ok("explicit wireframes do not get application-workspace requirements", !shouldRequireCollectionSurface({
  ...frontendPolicy,
  userPrompt: "Build a blank wireframe only for a task tracker",
}));
ok("non-frontend agents do not get collection workspace requirements", !shouldRequireCollectionSurface({
  ...frontendPolicy,
  agentType: "planning",
}));
ok("a habit tracker requires a representative browser journey", shouldRequireCoreJourney(frontendPolicy));
ok("a full-stack task tracker requires a representative browser journey", shouldRequireCoreJourney({
  ...frontendPolicy,
  taskDescription: "FULLSTACK BUILD: Build a task tracker",
}));
ok("a read-only analytics dashboard does not force a CRUD journey", !shouldRequireCoreJourney({
  ...frontendPolicy,
  userPrompt: "Build a read-only analytics dashboard",
}));
ok("a wireframe does not require a browser journey", !shouldRequireCoreJourney({
  ...frontendPolicy,
  userPrompt: "Build a blank wireframe only for a task tracker",
}));
ok("non-frontend agents do not require browser journeys", !shouldRequireCoreJourney({
  ...frontendPolicy,
  agentType: "planning",
}));

{
  const dispatcher = readFileSync(new URL("../src/agents/dispatcher.ts", import.meta.url), "utf8");
  ok("the agentic sweep uses the shared first-run policy", dispatcher.includes("shouldRequireInitialContent({"));
  ok("the agentic sweep carries the separate collection-surface policy", dispatcher.includes("shouldRequireCollectionSurface({"));
  ok("the tool context receives the collection-surface flag", dispatcher.includes("requireCollectionSurface,") && readFileSync(new URL("../src/agents/tools.ts", import.meta.url), "utf8").includes("requireCollectionSurface?: boolean"));
  const buildRoute = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  const start = buildRoute.indexOf("const revalidateStaleGates");
  const end = buildRoute.indexOf("await revalidateStaleGates();", start);
  const block = start >= 0 && end > start ? buildRoute.slice(start, end) : "";
  ok("post-repair page revalidation uses the multi-route sweep", block.includes("await checkRender(") && block.includes("allRoutesOk(page.report)"));
  ok("post-repair page revalidation does not downgrade to the homepage-only check", !block.includes("verifyBrowserRender("));
  ok("post-repair page revalidation preserves the same seeded-content rule", block.includes("shouldRequireInitialContent({"));
  ok("post-repair page revalidation repeats the collection-surface rule", block.includes("shouldRequireCollectionSurface({"));
}

// ── the script itself ────────────────────────────────────────────────────────

ok("the script launches exactly one browser", (RENDER_SCRIPT.match(/chromium\.launch\(/g) ?? []).length === 1);
ok("the script resets errors per route", RENDER_SCRIPT.includes("errors = []"));
ok("the script prints the marker", RENDER_SCRIPT.includes("LAMPCODE_RENDER:"));
ok("the browser sweep detects known first-run empty states", RENDER_SCRIPT.includes("INITIAL_EMPTY_STATE_RE"));
ok("the browser sweep checks desktop and mobile viewports", RENDER_SCRIPT.includes("width: 1440, height: 900") && RENDER_SCRIPT.includes("width: 390, height: 844"));
ok("the browser sweep measures password form width", RENDER_SCRIPT.includes('input[type="password"]') && RENDER_SCRIPT.includes("passwordFormWidth"));
ok("the browser sweep measures mobile horizontal overflow", RENDER_SCRIPT.includes("horizontalOverflow"));
ok("the browser sweep receives the app's first-run content policy from structured input", RENDER_SCRIPT.includes("input.requireInitialContent !== false"));
ok("the browser sweep receives the separate collection-surface policy", RENDER_SCRIPT.includes("input.requireCollectionSurface === true"));
ok("the collection-surface check measures semantic content rather than sample-record counts", RENDER_SCRIPT.includes("semanticBlocks") && RENDER_SCRIPT.includes("meaningfulGroups") && RENDER_SCRIPT.includes("contentIssue"));
ok("the content policy is passed into the evaluated page", /INITIAL_EMPTY_STATE_RE\.source, REQUIRE_INITIAL_CONTENT/.test(RENDER_SCRIPT));
ok("the script reads configuration from a JSON input file", RENDER_SCRIPT.includes('readFile(process.argv[2], "utf8")'));
ok("the script closes the browser in a finally", /finally\s*\{[\s\S]*browser\.close/.test(RENDER_SCRIPT));


{
  const service = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
  ok("render routes use per-run JSON input", service.includes("runSandboxScriptWithJsonInput(") && service.includes('"lampcode-render.mjs"') && service.includes("RENDER_SCRIPT"));
  ok("render service passes both independent content policies", service.includes("requireInitialContent, requireCollectionSurface"));
  ok("shell receives only the generated input path", service.includes('${TOOLS_ENV} node ${scriptPath} ${inputPath}') && !service.includes("JSON.stringify(JSON.stringify(routes))"));
}

// ── the overlay is hidden, never disabled ────────────────────────────────────
// MEASURED 2026-10-18: a person watching their build met a full-screen red
// stack trace next to a chat message saying the app was complete. Raw Vite
// internals are not an answer to give anybody.
//
// But check_page detects a module-resolution failure by querying
// vite-error-overlay and reading its shadow root — such a failure never
// reaches the console as an error, so that element is the only evidence there
// is. server.hmr.overlay:false removes the element and would blind the
// strongest page check in the product to fix a cosmetic problem.
//
// These pin the distinction, because "just turn the overlay off" is the
// obvious change and it is the wrong one.
{
  const svc = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
  const tpl = readFileSync(new URL("../e2b-template/template.ts", import.meta.url), "utf8");

  ok("the overlay is hidden with CSS", /vite-error-overlay\s*\{\s*display:\s*none/.test(svc));
  ok("and in the template too, so a rebuilt image keeps it", /vite-error-overlay\s*\{\s*display:\s*none/.test(tpl));

  // The one that matters. If either of these ever fails, the page check has
  // gone blind. Comments are stripped first — both files EXPLAIN why
  // `server.hmr.overlay: false` is wrong, and matching that prose would make
  // the case fail for saying the right thing.
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  ok("hmr.overlay is NOT disabled in the template", !/overlay\s*:\s*false/.test(code(tpl)));
  ok("nor anywhere in the preview service", !/overlay\s*:\s*false/.test(code(svc)));

  // Still read by the checker.
  ok(
    "the page check still queries the element",
    /querySelector\(["'`]vite-error-overlay/.test(tpl),
  );
  ok("and still reads its shadow root", /shadowRoot/.test(tpl));

  ok("hiding it can never fail a sandbox", /could not hide the Vite error overlay/.test(svc));
  ok("it is applied at runtime, not only baked", /hideViteOverlay\(sandbox\)/.test(svc));
}

console.log(failures === 0 ? "\nAll render cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
