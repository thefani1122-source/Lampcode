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

if (failures > 0) {
  console.error(`\n${failures} security case(s) FAILED`);
  process.exit(1);
}
console.log("\nAll security cases passed.");
