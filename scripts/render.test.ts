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

const overlay = parseRenderReport(
  line({ routes: [{ route: "/", blank: false, errors: [], text: "", overlay: "Failed to resolve import ./Foo" }], unreachable: [] }),
);
ok("a Vite overlay is not ok", overlay?.routes[0]?.ok === false);

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

// ── the script itself ────────────────────────────────────────────────────────

ok("the script launches exactly one browser", (RENDER_SCRIPT.match(/chromium\.launch\(/g) ?? []).length === 1);
ok("the script resets errors per route", RENDER_SCRIPT.includes("errors = []"));
ok("the script prints the marker", RENDER_SCRIPT.includes("LAMPCODE_RENDER:"));
ok("the script closes the browser in a finally", /finally\s*\{[\s\S]*browser\.close/.test(RENDER_SCRIPT));


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
