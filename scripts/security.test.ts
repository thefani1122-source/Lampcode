/**
 * Cases for the security verifier. Run by `npm test`.
 *
 * This module drives build.ts's hard-block and auto-fix loop and had no cases
 * at all, which is the same gap pricing.ts had: the function behind a gate,
 * unprotected by anything that would notice it changing.
 *
 * The property these protect is the opposite of the dead-code analyser's. There
 * the cost of a false positive is deleted working code, so every rule
 * under-reports. Here a missed finding is an unprotected API or an open CORS
 * policy shipped to a user, so the cases below are weighted toward blind spots
 * — and specifically toward the one failure shape that is worse than a missed
 * finding: reporting a clean PASS over files that were never scanned.
 */

import { readFileSync } from "node:fs";
import { checkAuth, checkCORS, type FileTree } from "../src/verify/security.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

/** For assertions that are already a boolean rather than a comparison. */
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

// ── checkAuth: the files it looks at ─────────────────────────────────────────

// The blind spot this was written for. Lampcode's own generated Hono backend
// is src/server/index.ts, and a selector keyed on "/routes/" or "route" never
// opened it — so an app with no auth anywhere reported
// "All API route files apply auth middleware".
const UNPROTECTED_ENTRY = `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/invoices", (c) => c.json(db.invoices));
app.post("/api/invoices", (c) => c.json(create(c)));
export default app;
`;

check(
  "checkAuth: unprotected routes in src/server/index.ts are caught",
  checkAuth(tree({ "src/server/index.ts": UNPROTECTED_ENTRY })).status,
  "fail",
);

check(
  "checkAuth: the same routes in main.ts are caught",
  checkAuth(tree({ "src/server/main.ts": UNPROTECTED_ENTRY })).status,
  "fail",
);

check(
  "checkAuth: a guarded entry file passes",
  checkAuth(
    tree({
      "src/server/index.ts": `
import { requireAuth } from "./auth.js";
const app = new Hono();
app.use("/api/*", requireAuth);
app.get("/api/invoices", (c) => c.json(db.invoices));
`,
    }),
  ).status,
  "pass",
);

// Routes declared under a mount prefix never contain the "/api" literal, which
// is the standard Hono composition pattern and was skipped entirely.
check(
  "checkAuth: routes mounted under an /api prefix are caught",
  checkAuth(
    tree({
      "src/server/index.ts": `
const users = new Hono();
users.get("/users", (c) => c.json(all()));
users.delete("/users/:id", (c) => c.json(remove(c)));
app.route("/api", users);
`,
    }),
  ).status,
  "fail",
);

// ── checkAuth: zero scanned is not a pass ────────────────────────────────────

check(
  "checkAuth: a browser-only project reports skip, not pass",
  checkAuth(
    tree({
      "src/App.tsx": "export default function App() { return <div />; }",
      "src/lib/storage.ts": "export const load = () => localStorage.getItem('x');",
    }),
  ).status,
  "skip",
);

check(
  "checkAuth: an entry file with no API routes reports skip",
  checkAuth(tree({ "src/server/index.ts": "const app = new Hono();\nexport default app;" })).status,
  "skip",
);

// ── checkAuth: the auth-route exemption ──────────────────────────────────────

check(
  "checkAuth: a real auth route file is exempt",
  checkAuth(
    tree({ "src/server/routes/auth.ts": `app.post("/api/login", (c) => signIn(c));` }),
  ).status,
  "skip",
);

// The substring test swallowed anything merely containing the letters, so a
// file about authors was exempted from the check along with it.
check(
  "checkAuth: author.ts is NOT treated as an auth route",
  checkAuth(
    tree({ "src/server/routes/author.ts": `app.get("/api/authors", (c) => c.json(all()));` }),
  ).status,
  "fail",
);

check(
  "checkAuth: authorize-admin.ts is NOT treated as an auth route",
  checkAuth(
    tree({
      "src/server/routes/authorize-admin.ts": `app.post("/api/admin/grant", (c) => grant(c));`,
    }),
  ).status,
  "fail",
);

// ── checkAuth: what counts as a guard ────────────────────────────────────────

for (const guard of ["requireAuth", "authenticate", "verifyToken", "isAuthenticated"]) {
  check(
    `checkAuth: ${guard} counts as a guard`,
    checkAuth(
      tree({
        "src/server/index.ts": `import { ${guard} } from "./mw.js";\napp.get("/api/x", ${guard}, h);`,
      }),
    ).status,
    "pass",
  );
}

// ── checkCORS ────────────────────────────────────────────────────────────────

check(
  "checkCORS: an explicit wildcard origin still fails",
  checkCORS(tree({ "src/server/index.ts": `app.use(cors({ origin: "*" }))` })).status,
  "fail",
);

check(
  "checkCORS: a raw Access-Control-Allow-Origin header still fails",
  checkCORS(
    tree({ "src/server/index.ts": `c.header("Access-Control-Allow-Origin", "*")` }),
  ).status,
  "fail",
);

// A bare cors() defaults to origin "*" — the same hole with no text to match,
// and the subject of hono's own CORS advisory. Reported, but as warn: only
// `fail` drives the auto-fix loop, and the rate at which generated backends
// use a bare cors() has not been measured.
const bare = checkCORS(
  tree({ "src/server/index.ts": `import { cors } from "hono/cors";\napp.use(cors());` }),
);
check("checkCORS: a bare cors() is reported", bare.status, "warn");
check("checkCORS: a bare cors() does not drive the fix loop", bare.status !== "fail", true);
check("checkCORS: a bare cors() names the file", bare.file, "src/server/index.ts");

check(
  "checkCORS: cors() with whitespace is still caught",
  checkCORS(tree({ "src/server/index.ts": `app.use( cors(  ) )` })).status,
  "warn",
);

check(
  "checkCORS: an explicit origin passes",
  checkCORS(
    tree({ "src/server/index.ts": `app.use(cors({ origin: "https://app.example.com" }))` }),
  ).status,
  "pass",
);

check(
  "checkCORS: a project with no CORS at all passes",
  checkCORS(tree({ "src/App.tsx": "export default () => <div />;" })).status,
  "pass",
);

// An explicit wildcard outranks a bare call when both appear: the unambiguous
// one is the finding worth acting on.
check(
  "checkCORS: an explicit wildcard wins over a bare call",
  checkCORS(
    tree({
      "src/server/index.ts": `app.use(cors());`,
      "src/server/admin.ts": `app.use(cors({ origin: "*" }));`,
    }),
  ).status,
  "fail",
);

// ── G1: no service-role key for the SHARED preview project ───────────────────
// Decided 2026-10-17. The shared preview Supabase sits behind every user's
// preview at once, and a service-role key bypasses RLS entirely, so the code it
// was handed to — model-written, steered by whatever a stranger typed — could
// read and write every other user's preview rows.
//
// These read the files as TEXT on purpose. Importing e2b-service.ts outside the
// server process hangs (it pulls config, Redis and the E2B SDK), which is the
// same reason review-units.ts copies its baked-file list instead of importing
// it. Each assertion is written against the INTENT, not a line, so that a
// rename or a reformat does not fail it and a reintroduced key cannot pass it.
{
  const configSrc = readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  const previewSrc = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");

  ok(
    "config declares no shared preview service key",
    !/PREVIEW_SUPABASE_SERVICE_KEY\s*:\s*z\./.test(configSrc),
  );
  ok(
    "the .env writer cannot source one from config",
    !/config\.PREVIEW_SUPABASE_SERVICE_KEY/.test(previewSrc),
  );
  // The capability is narrowed, not deleted: a user's own connected project
  // still gets its key, because the schema is applied there and it is their
  // data. A change that removed this too would be over-correcting, and silently.
  ok(
    "a user's own project still passes its service key",
    /override\?\.serviceKey/.test(previewSrc),
  );
  // The original guard, still worth pinning: whatever else happens, a service
  // key must never reach the browser. Vite exposes exactly the VITE_ prefix.
  ok("no service key is ever VITE_-prefixed", !/VITE_SUPABASE_SERVICE/.test(previewSrc));
}


// ── a check that cannot be satisfied ─────────────────────────────────────────
// MEASURED on a real build, 2026-10-18. checkAuth matched four literal guard
// names. G5 had just changed what a correct Supabase backend looks like — a
// per-request client carrying the caller's Authorization header, so auth.uid()
// resolves and RLS decides access — and that shape contains none of those
// words. The prompt taught one thing, the check demanded another, two repair
// dispatches were spent, and the app shipped with "try a follow-up prompt".
//
// A check that cannot be satisfied is worse than no check: it costs money and
// ends in the same place.

const G5_BACKEND = `
import { createClient } from '@supabase/supabase-js'
function dbFor(c) {
  const token = c.req.header('Authorization') || ''
  return createClient(URL, ANON, { global: { headers: { Authorization: token } } })
}
app.get('/api/riders', (c) => dbFor(c).from('riders').select('*'))
app.post('/api/riders', (c) => dbFor(c).from('riders').insert(x))
`;

check(
  "forwarding the caller's identity counts as protected",
  checkAuth(tree({ "src/server/routes/api.ts": G5_BACKEND })).status,
  "pass",
);

// The named-guard shape must keep working — this is an addition, not a swap.
check(
  "a named requireAuth guard still counts",
  checkAuth(
    tree({
      "src/server/routes/api.ts": `import { requireAuth } from './auth'\napp.use('/api/*', requireAuth)\napp.get('/api/x', h)`,
    }),
  ).status,
  "pass",
);

// And the check must still BITE. A backend that neither guards nor forwards
// anything is the thing this exists to catch.
check(
  "a wide-open backend still fails",
  checkAuth(
    tree({ "src/server/routes/api.ts": `app.get('/api/x', (c) => db.from('x').select('*'))\napp.post('/api/x', h)` }),
  ).status,
  "fail",
);

// Naming the remedy is what makes the finding fixable in one attempt rather
// than unfixable in two.
{
  const msg = checkAuth(tree({ "src/server/routes/api.ts": `app.get('/api/x', h)\napp.post('/api/x', h)` })).message;
  ok("the message names the middleware route to a fix", msg.includes("requireAuth"));
  ok("and the forwarded-identity route", msg.includes("Authorization"));
  ok("and forbids the obvious cheat", /Do not simply rename/i.test(msg));
}

if (failures > 0) {
  console.error(`\n${failures} security case(s) FAILED`);
  process.exit(1);
}
console.log("\nAll security cases passed.");
