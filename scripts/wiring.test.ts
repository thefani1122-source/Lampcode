/**
 * Cases for the wiring analyser. Run by `npm test`.
 *
 * The property these protect is PRECISION, the same as the dead-code cases but
 * for the opposite reason. There, a false positive deletes working code. Here, a
 * false positive sends a repair dispatch to rewrite an element that was already
 * correct — and a repair that changes working code is a regression, not a fix.
 *
 * So most of what follows asserts that something which LOOKS hollow is left
 * alone: a button receiving its handler from a parent, a bare button inside a
 * form (which submits it by default), a link to a declared route, a fetch whose
 * backend mounts the same path under a prefix.
 */

import {
  findWiringGaps,
  tallyWiringGaps,
  repairableGaps,
  formatWiringGaps,
  formatWiringForUser,
  extractTags,
  handlerExpressions,
  isDeadHandler,
  tagAttributes,
  normalizeRoute,
  declaredRoutes,
  linkTargets,
  backendEndpoints,
  requestedEndpoints,
} from "../src/verify/wiring.js";
import type { WiringFinding, WiringKind } from "../src/verify/wiring.js";

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

const kinds = (files: Record<string, string>) =>
  findWiringGaps(files).map((f) => f.kind).sort();

// ── tag extraction ───────────────────────────────────────────────────────────
// A regex for `<button[^>]*>` cuts both of these tags in half, and then every
// attribute test downstream reads a fragment of a tag.

const tags = (code: string, name: string) =>
  extractTags(code, name).map((t) => t.source);

check(
  "extractTags: a > inside a braced expression does not end the tag",
  tags(`<button onClick={() => setN(n > 1)}>Go</button>`, "button"),
  [`<button onClick={() => setN(n > 1)}>`],
);

check(
  "extractTags: a > inside a string does not end the tag",
  tags(`<button title="a > b">x</button>`, "button"),
  [`<button title="a > b">`],
);

check(
  "extractTags: a bare tag, with where it starts",
  extractTags(`<div><button>Save</button></div>`, "button"),
  [{ source: `<button>`, index: 5 }],
);

check(
  "extractTags: does not match a longer tag name",
  tags(`<buttonish /><FormField />`, "button").length + tags(`<FormField />`, "form").length,
  0,
);

// ── handlers injected by an asChild parent ───────────────────────────────────
// Measured against 93 hand-written files: the two false positives the rules
// produced were both this, a <button> inside <DropdownMenuTrigger asChild>,
// where Radix clones the child and injects onClick. The template ships shadcn,
// so generated apps are full of them.

check(
  "a button inside an asChild trigger is left alone",
  kinds({
    "src/Menu.tsx":
      `export function M() { return <DropdownMenu><DropdownMenuTrigger asChild>` +
      `<button className="x">Open</button>` +
      `</DropdownMenuTrigger></DropdownMenu>; }`,
  }),
  [],
);

// …but the skip must not leak onto the next control in the file. The same probe
// found a genuinely dead button a few hundred characters after a real trigger,
// and a file-wide asChild test would have hidden it.
check(
  "a bare button AFTER a closed asChild trigger is still reported",
  kinds({
    "src/Menu.tsx":
      `export function M() { return <div><DropdownMenuTrigger asChild>` +
      `<button>Open</button>` +
      `</DropdownMenuTrigger>` +
      `<button title="Switch project">Switch</button>` +
      `</div>; }`,
  }),
  ["button-no-handler"],
);

// ── attribute names ──────────────────────────────────────────────────────────
// Both of these were real bugs in the first version of the scanner. Requiring a
// following `=` made `<button disabled>` read as having no attributes, so it was
// reported as unwired. Not stripping values made a name inside a string count,
// so a labelled button was skipped as already wired.

check(
  "tagAttributes: a bare boolean attribute counts",
  tagAttributes(`<button disabled>`),
  ["disabled"],
);

check(
  "tagAttributes: a name inside a string does not",
  tagAttributes(`<button title="onClick demo">`),
  ["title"],
);

check(
  "tagAttributes: a braced value is not mined for names",
  tagAttributes(`<button onClick={() => onSubmitSomething()}>`),
  ["onClick"],
);

// ── handler expressions ──────────────────────────────────────────────────────

check(
  "handlerExpressions: nested braces are kept whole",
  handlerExpressions(`<button onClick={() => { setOpen(!open); }}>x</button>`),
  [{ name: "onClick", expr: `() => { setOpen(!open); }` }],
);

check(
  "handlerExpressions: several handlers on one element",
  handlerExpressions(`<input onChange={a} onBlur={b} />`).map((h) => h.name),
  ["onChange", "onBlur"],
);

// ── dead handler classification ──────────────────────────────────────────────

for (const dead of [
  `() => {}`,
  `(e) => {}`,
  `e => {}`,
  `async () => {}`,
  `() => {   }`,
  `() => void 0`,
  `() => undefined`,
  `function () {}`,
  `() => { console.log("clicked") }`,
  `() => { console.log(a); console.log(b); }`,
]) {
  ok(`isDeadHandler: ${dead}`, isDeadHandler(dead));
}

for (const live of [
  `handleClick`,
  `() => setOpen(true)`,
  `() => { setOpen(true); }`,
  `() => { alert("saved") }`,
  `(e) => { e.preventDefault(); save(); }`,
  `async () => { await save(); }`,
  `() => navigate("/todos")`,
]) {
  ok(`isDeadHandler leaves alone: ${live}`, !isDeadHandler(live));
}

// A named handler that happens to be empty is a MISSED finding on purpose:
// judging it means resolving the identifier, which this module does not do.
check(
  "a handler passed by name is never judged, even when its body is empty",
  kinds({
    "src/Thing.tsx":
      `function noop() {}\n` +
      `export function Thing() { return <button onClick={noop}>Go</button>; }\n`,
  }),
  [],
);

// ── buttons ──────────────────────────────────────────────────────────────────

check(
  "a bare button is reported",
  kinds({ "src/Bar.tsx": `export function Bar() { return <div><button>Save</button></div>; }` }),
  ["button-no-handler"],
);

check(
  "a button with an onClick is not",
  kinds({ "src/Bar.tsx": `export function Bar() { return <button onClick={save}>Save</button>; }` }),
  [],
);

check(
  "a button forwarding props from a wrapper is not",
  kinds({ "src/Btn.tsx": `export function Btn(props) { return <button {...props}>x</button>; }` }),
  [],
);

check(
  "a disabled button is not",
  kinds({ "src/Bar.tsx": `export function Bar() { return <button disabled>Save</button>; }` }),
  [],
);

// A bare <button> inside a form submits it — reporting it would be wrong, and
// the fix would attach a handler that double-submits. The whole file is skipped
// because finding the form boundary needs a parser.
check(
  "a bare button in a file containing a form is left alone",
  kinds({
    "src/Form.tsx":
      `export function F() { return <form onSubmit={save}><button>Save</button></form>; }`,
  }),
  [],
);

check(
  "a type=submit button outside a form is not reported",
  kinds({
    "src/Bar.tsx": `export function Bar() { return <button type="submit">Go</button>; }`,
  }),
  [],
);

// ── a dead handler is reported once, not twice ───────────────────────────────
// The element has an onClick, so the button rule must stay quiet and let the
// handler rule own the finding.
check(
  "an empty onClick yields exactly one finding",
  kinds({
    "src/Bar.tsx": `export function Bar() { return <button onClick={() => {}}>Save</button>; }`,
  }),
  ["dead-handler"],
);

// ── forms ────────────────────────────────────────────────────────────────────

check(
  "a form with no onSubmit and no action is reported",
  kinds({ "src/F.tsx": `export function F() { return <form><input /></form>; }` }),
  ["form-no-submit"],
);

check(
  "a form with onSubmit is not",
  kinds({ "src/F.tsx": `export function F() { return <form onSubmit={go}><input /></form>; }` }),
  [],
);

// ── routes and links ─────────────────────────────────────────────────────────

check("normalizeRoute: express param", normalizeRoute("/api/todos/:id"), "/api/todos/*");
check("normalizeRoute: fastapi param", normalizeRoute("/api/todos/{id}"), "/api/todos/*");
check("normalizeRoute: template literal", normalizeRoute("/api/todos/${id}"), "/api/todos/*");
check("normalizeRoute: trailing slash", normalizeRoute("/api/todos/"), "/api/todos");
check("normalizeRoute: root", normalizeRoute("/"), "/");
check("normalizeRoute: query is dropped", normalizeRoute("/api/x?y=1"), "/api/x");

check(
  "declaredRoutes: jsx and object form",
  declaredRoutes(`<Route path="/todos" /> ... { path: "/rules" }`).sort(),
  ["/rules", "/todos"],
);

check(
  "linkTargets: internal only",
  linkTargets(
    `<Link to="/todos" /><a href="https://x.com" /><a href="#top" /><a href="mailto:a@b.c" />` +
    `<a href="relative" />`,
  ),
  ["/todos"],
);

const ROUTED = {
  "src/App.tsx":
    `import { WeekGrid } from "./WeekGrid";\n` +
    `export function App() { return <Routes>` +
    `<Route path="/" element={<WeekGrid />} />` +
    `<Route path="/shifts" element={<WeekGrid />} />` +
    `</Routes>; }\n`,
  "src/Nav.tsx":
    `export function Nav() { return <nav>` +
    `<Link to="/shifts">Shifts</Link>` +
    `<Link to="/rules">Rules</Link>` +
    `</nav>; }\n`,
};

check("a link to an undeclared route is reported", kinds(ROUTED), ["dead-link"]);

check(
  "and it names the path the user would click",
  findWiringGaps(ROUTED).find((f) => f.kind === "dead-link")?.symbol,
  "/rules",
);

// Without a route table there is nothing to compare against, and an app using
// anchors for in-page navigation would have every one of them reported.
check(
  "links are not checked in a project that declares no routes",
  kinds({ "src/Nav.tsx": `export function Nav() { return <a href="/rules">Rules</a>; }` }),
  [],
);

// ── frontend and backend disagreeing about the API ───────────────────────────

check(
  "backendEndpoints: hono/express and fastapi shapes",
  backendEndpoints(
    `app.get("/api/todos", h)\n` +
    `router.post("/api/todos/:id", h)\n` +
    `@app.delete("/api/todos/{id}")\n`,
  ).sort(),
  ["/api/todos", "/api/todos/:id", "/api/todos/{id}"],
);

check(
  "requestedEndpoints: string and template forms",
  requestedEndpoints('fetch("/api/todos"); fetch(`/api/todos/${id}`); axios.get("/api/stats")').sort(),
  ["/api/stats", "/api/todos", "/api/todos/${id}"],
);

// Both halves of a path mismatch are reported, and that is deliberate: the
// frontend calling a route that does not exist and the backend defining one
// nobody calls are the SAME bug seen from either end, and the pair is what
// identifies it as a mismatch rather than a missing feature. A repair that
// fixes one path clears both findings.
check(
  "a path mismatch is reported from both sides",
  kinds({
    "src/server/index.ts": `app.get("/api/todos", h)`,
    "src/List.tsx": `export function L() { return <div onClick={() => fetch("/api/shifts")} />; }`,
  }),
  ["missing-endpoint", "orphan-endpoint"],
);

check(
  "a fetch that matches is not",
  kinds({
    "src/server/index.ts": `app.get("/api/todos", h)`,
    "src/List.tsx": `export function L() { return <div onClick={() => fetch("/api/todos")} />; }`,
  }),
  [],
);

// The backend mounts its router under /api and so declares the bare path. Both
// spellings have to count or every correct full-stack app is reported.
check(
  "a backend route declared without the /api prefix still matches",
  kinds({
    "src/server/index.ts": `router.get("/todos", h)`,
    "src/List.tsx": `export function L() { return <div onClick={() => fetch("/api/todos")} />; }`,
  }),
  [],
);

check(
  "a path parameter matches a template literal call",
  kinds({
    "src/server/index.ts": "app.delete(\"/api/todos/:id\", h)",
    "src/List.tsx":
      "export function L() { return <div onClick={() => fetch(`/api/todos/${id}`)} />; }",
  }),
  [],
);

check(
  "an endpoint no frontend file calls is reported",
  kinds({
    "src/server/index.ts": `app.get("/api/todos", h)\napp.get("/api/stats", h)`,
    "src/List.tsx": `export function L() { return <div onClick={() => fetch("/api/todos")} />; }`,
  }),
  ["orphan-endpoint"],
);

// A frontend that makes no API calls at all is more likely unfinished than
// wrong about every endpoint, and reporting the whole backend is noise.
check(
  "the backend is not reported when the frontend calls nothing",
  kinds({
    "src/server/index.ts": `app.get("/api/todos", h)`,
    "src/List.tsx": `export function L() { return <div />; }`,
  }),
  [],
);

check(
  "fetches are not checked in a project with no backend",
  kinds({ "src/List.tsx": `export function L() { return <div onClick={() => fetch("/api/x")} />; }` }),
  [],
);

// ── placeholder copy ─────────────────────────────────────────────────────────

check(
  "stub copy that shipped is reported",
  kinds({ "src/Rules.tsx": `export function R() { return <div>Coming soon</div>; }` }),
  ["placeholder-text"],
);

check(
  "ordinary copy is not",
  kinds({ "src/Rules.tsx": `export function R() { return <div>Shift rules</div>; }` }),
  [],
);

// ── scope ────────────────────────────────────────────────────────────────────

check("an empty project yields nothing", findWiringGaps({}), []);

check(
  "a test file is not analysed",
  kinds({ "src/App.test.tsx": `it("x", () => { render(<button>Save</button>); })` }),
  [],
);

check(
  "a non-JSX file is not scanned for elements",
  kinds({ "src/util.ts": `export const x = "<button>Save</button>";` }),
  [],
);

// ── tally and report ─────────────────────────────────────────────────────────

const HOLLOW = {
  "src/App.tsx":
    `export function App() { return <Routes><Route path="/" element={<H />} /></Routes>; }`,
  "src/H.tsx":
    `export function H() { return <div>` +
    `<button>Save</button>` +
    `<button onClick={() => {}}>Delete</button>` +
    `<Link to="/rules">Rules</Link>` +
    `<p>Coming soon</p>` +
    `</div>; }`,
};

const t = tallyWiringGaps(findWiringGaps(HOLLOW));
check("the tally counts dead handlers", t.deadHandlers, 1);
check("the tally counts bare buttons", t.bareButtons, 1);
check("the tally counts dead links", t.deadLinks, 1);
check("the tally counts placeholder copy", t.placeholders, 1);
check("the tally totals", t.total, 4);

// ── what a repair loop is allowed to act on ──────────────────────────────────
// The two left out are not the mild ones. They are the two whose fix is a
// product decision: an endpoint nothing calls is fixed by building its UI or by
// deleting it, which are opposite outcomes, and "coming soon" is fixed by
// building the feature. Dispatching on either lets the loop choose for the user.

check(
  "the repairable set excludes the two that need a product decision",
  repairableGaps(
    findWiringGaps({
      "src/server/index.ts": `app.get("/api/todos", h)\napp.get("/api/stats", h)`,
      "src/H.tsx":
        `export function H() { return <div>` +
        `<button>Save</button>` +
        `<p>Coming soon</p>` +
        `<div onClick={() => fetch("/api/todos")} />` +
        `</div>; }`,
    }),
  ).map((f) => f.kind),
  ["button-no-handler"],
);

check(
  "and a clean project has nothing to repair",
  repairableGaps(findWiringGaps({ "src/H.tsx": `export function H() { return <div />; }` })),
  [],
);

const empty = tallyWiringGaps([]);
check("an empty tally is all zeroes", empty.total, 0);

const report = formatWiringGaps(findWiringGaps(HOLLOW));
ok("the report counts the findings", report.startsWith("4 thing(s)"));
ok("the report names the file", report.includes("src/H.tsx"));
ok(
  "the report forbids satisfying a finding by deleting the element",
  report.includes("Do not satisfy a finding by deleting the element"),
);
ok(
  "a clean project reports that it is clean",
  formatWiringGaps([]).includes("Nothing hollow found"),
);

// ── what the USER is told ────────────────────────────────────────────────────
// The repair loop deliberately declines two of the seven kinds, so those
// findings only exist for the user's next prompt. Unsaid, that design decision
// is indistinguishable from the check not working.

const gap = (kind: WiringKind, symbol: string): WiringFinding => ({
  kind,
  path: "src/H.tsx",
  symbol,
  detail: "irrelevant to the user-facing text",
});

check(
  "a clean build says nothing at all",
  formatWiringForUser([], 0),
  [],
);

check(
  "a build where everything was repaired says so, in the singular",
  formatWiringForUser([], 1),
  ["One control in the app wasn't connected to anything — I wired it up."],
);

check(
  "and in the plural",
  formatWiringForUser([], 3),
  ["3 controls in the app weren't connected to anything — I wired them up."],
);

// The two groups are different claims: one is our failure, the other is a
// question. They must not be blended into one list.
check(
  "what could not be fixed and what was declined are kept apart",
  formatWiringForUser(
    [gap("button-no-handler", "<button>"), gap("orphan-endpoint", "/api/stats")],
    2,
  ),
  [
    "2 controls in the app weren't connected to anything — I wired them up.",
    "I couldn't finish wiring everything. These still don't work:",
    "  • a button that isn't connected to anything",
    "And these I've left for you to decide:",
    "  • something the server can already do that nothing in the app uses yet",
    "Tell me which of these you want and I'll build it.",
  ],
);

// This exact line was wrong on the first write — built by patching a plural
// string, which produced "One thing things I've left".
check(
  "a single declined finding reads as singular",
  formatWiringForUser([gap("placeholder-text", "Coming soon")], 0),
  [
    "One thing I've left for you to decide:",
    '  • a section that still says it\'s "coming soon" instead of being built',
    "Tell me which of these you want and I'll build it.",
  ],
);

check(
  "several declined findings read as plural",
  formatWiringForUser(
    [gap("placeholder-text", "Coming soon"), gap("orphan-endpoint", "/api/stats")],
    0,
  )[0],
  "A few things I've left for you to decide:",
);

// A route path is the one symbol here already in the user's language — they
// asked for that page by name.
check(
  "a dead link names the page the user asked for",
  formatWiringForUser([gap("dead-link", "/rules")], 0)[1],
  "  • a link to a page that doesn't exist (/rules)",
);

check(
  "but not when there are too many to read",
  formatWiringForUser(
    ["/a", "/b", "/c", "/d"].map((p) => gap("dead-link", p)),
    0,
  )[1],
  "  • 4 links to pages that don't exist",
);

// No file path and no code identifier may reach the user. The same split the
// completion audit had to make after its card was pulled for talking like a
// maintainer.
ok(
  "nothing shown to the user names a file or an identifier",
  formatWiringForUser(
    [
      gap("dead-handler", "onClick"),
      gap("missing-endpoint", "/api/shifts"),
      gap("placeholder-text", "Coming soon"),
    ],
    1,
  ).every((l) => !l.includes("src/") && !l.includes(".tsx") && !l.includes("onClick")),
);

// ── a real shape: the ROTA failure, one level down ────────────────────────────
// Four views written, imported, routed — and every control inside them inert.
// Every gate we have passes this: it renders, it type-checks, and a test that
// imports the rule engine directly passes whether or not any of this is wired.
const ROTA_LIKE = {
  "src/App.tsx":
    `import { WeekGrid } from "./views/WeekGrid";\n` +
    `export function App() { return <Routes>` +
    `<Route path="/" element={<WeekGrid />} />` +
    `</Routes>; }\n`,
  "src/views/WeekGrid.tsx":
    `export function WeekGrid() {\n` +
    `  return (<div>\n` +
    `    <button onClick={() => {}}>Publish</button>\n` +
    `    <Link to="/conflicts">Conflicts</Link>\n` +
    `  </div>);\n` +
    `}\n`,
};

check(
  "the hollow-app shape is caught in full",
  kinds(ROTA_LIKE),
  ["dead-handler", "dead-link"],
);

console.log(failures === 0 ? "\nAll wiring cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
