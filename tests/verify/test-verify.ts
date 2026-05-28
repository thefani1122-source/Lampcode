/**
 * Security + Connection Verifier — unit tests.
 *
 * Tests:
 *   - Security checks: auth, RLS, secrets, OWASP (XSS/SQLi/CSRF), packages, CORS, Stripe
 *   - Connection checks: api-contracts, schema-match, auth-flow, env-vars, no-localhost
 *   - Auto-fix: round progression, escalation after max rounds
 *
 * Zero DB / config / network dependencies.
 *
 * Usage:
 *   npx tsx src/verify/test-verify.ts
 */

import {
  checkAuth,
  checkRLS,
  checkSecrets,
  checkOWASP,
  checkPackages,
  checkCORS,
  checkStripe,
  type FileTree,
  type SecurityReport,
} from "./security.js";
import {
  checkApiContracts,
  checkSchemaMatch,
  checkAuthFlow,
  checkEnvVars,
  checkNoLocalhost,
  type ConnectionReport,
} from "./connection.js";
import { autoFix, type FixAgent } from "./fix.js";

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}
const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

async function run(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(70)} ... `);
    try {
      await fn();
      console.log("OK");
      passed++;
    } catch (e) {
      console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
}

function assert(cond: boolean, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}
function eq<T>(a: T, b: T, msg?: string): void {
  if (a !== b) throw new Error(msg ?? `Expected ${String(b)}, got ${String(a)}`);
}

// ── File tree builders ────────────────────────────────────────────────────────

function ft(entries: Record<string, string>): FileTree {
  return new Map(Object.entries(entries));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ROUTE_NO_AUTH = ft({
  "src/routes/users.ts": `
    import { Hono } from "hono";
    const router = new Hono();
    router.get("/api/users", async (c) => c.json([]));
    router.post("/api/users", async (c) => c.json({}));
  `,
});

const ROUTE_WITH_AUTH = ft({
  "src/routes/users.ts": `
    import { Hono } from "hono";
    import { requireAuth } from "../middleware/auth.js";
    const router = new Hono();
    router.use("/*", requireAuth);
    router.get("/api/users", async (c) => c.json([]));
  `,
});

const ROUTE_AUTH_FILE = ft({
  "src/routes/auth.ts": `
    import { Hono } from "hono";
    const router = new Hono();
    router.post("/api/auth/login", async (c) => c.json({}));
  `,
});

const SQL_NO_RLS = ft({
  "migrations/001_init.sql": `
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT);
  `,
});

const SQL_WITH_RLS = ft({
  "migrations/001_init.sql": `
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    CREATE POLICY user_own ON users FOR ALL USING (id = auth.uid());
  `,
});

const SQL_RLS_NO_POLICY = ft({
  "migrations/001_init.sql": `
    CREATE TABLE orders (id TEXT PRIMARY KEY);
    ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  `,
});

const CLIENT_WITH_SECRET = ft({
  "src/components/Payment.tsx": `
    const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456789012";
    export function Payment() { return null; }
  `,
});

const CLIENT_CLEAN = ft({
  "src/components/Payment.tsx": `
    const apiKey = process.env.NEXT_PUBLIC_STRIPE_PK;
    export function Payment() { return null; }
  `,
});

const STRIPE_KEY_IN_CLIENT = ft({
  "src/components/Checkout.tsx": `
    const key = "sk_live_abcdefghijklmnopqrstuvwxyz1234";
    export default function Checkout() { return null; }
  `,
});

const XSS_FILE = ft({
  "src/components/HtmlRenderer.tsx": `
    function Renderer({ html }: { html: string }) {
      return <div dangerouslySetInnerHTML={{ __html: html }} />;
    }
  `,
});

const SQLI_FILE = ft({
  "src/server/db.ts": `
    async function getUser(id: string) {
      return query(\`SELECT * FROM users WHERE id = \${id}\`);
    }
  `,
});

const CSRF_FILE = ft({
  "src/pages/Login.tsx": `
    export function Login() {
      return (
        <form method="post" action="/login">
          <input type="text" name="username" />
          <button type="submit">Login</button>
        </form>
      );
    }
  `,
});

const UNDECLARED_IMPORT = ft({
  "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" }, devDependencies: {} }),
  "src/server/index.ts": `
    import { Hono } from "hono";
    import { verify } from "jsonwebtoken-secure";
  `,
});

const ALL_DECLARED = ft({
  "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0", zod: "^3.0.0" }, devDependencies: {} }),
  "src/server/index.ts": `
    import { Hono } from "hono";
    import { z } from "zod";
  `,
});

const CORS_WILDCARD = ft({
  "src/server/app.ts": `
    import { cors } from "hono/cors";
    app.use(cors({ origin: "*", allowMethods: ["GET", "POST"] }));
  `,
});

const CORS_SPECIFIC = ft({
  "src/server/app.ts": `
    import { cors } from "hono/cors";
    app.use(cors({ origin: "https://myapp.com", allowMethods: ["GET", "POST"] }));
  `,
});

const STRIPE_NO_VERIFY = ft({
  "src/server/webhooks.ts": `
    import Stripe from "stripe";
    const stripe = new Stripe(process.env.STRIPE_KEY!);
    app.post("/webhook", async (c) => {
      const event = await c.req.json();
    });
  `,
});

const STRIPE_WITH_VERIFY = ft({
  "src/server/webhooks.ts": `
    import Stripe from "stripe";
    const stripe = new Stripe(process.env.STRIPE_KEY!);
    app.post("/webhook", async (c) => {
      const sig = c.req.header("stripe-signature")!;
      const event = stripe.webhooks.constructEvent(body, sig, secret);
    });
  `,
});

// ── Security: checkAuth ───────────────────────────────────────────────────────

test("checkAuth: fails when route file has no auth middleware", () => {
  const r = checkAuth(ROUTE_NO_AUTH);
  eq(r.status, "fail", "Should fail");
  eq(r.severity, "critical");
  assert(r.file !== undefined, "Should report file");
});

test("checkAuth: passes when requireAuth is used", () => {
  const r = checkAuth(ROUTE_WITH_AUTH);
  eq(r.status, "pass");
});

test("checkAuth: skips auth route files (they're intentionally public)", () => {
  const r = checkAuth(ROUTE_AUTH_FILE);
  eq(r.status, "pass", "Auth routes should not be flagged");
});

test("checkAuth: passes on empty file tree", () => {
  const r = checkAuth(new Map());
  eq(r.status, "pass");
});

// ── Security: checkRLS ────────────────────────────────────────────────────────

test("checkRLS: fails when SQL tables have no RLS", () => {
  const r = checkRLS(SQL_NO_RLS);
  eq(r.status, "fail");
  assert(r.message.includes("users") || r.message.includes("posts"), "Should name tables");
});

test("checkRLS: passes when RLS + policy are present", () => {
  const r = checkRLS(SQL_WITH_RLS);
  eq(r.status, "pass");
});

test("checkRLS: fails when RLS enabled but no policy", () => {
  const r = checkRLS(SQL_RLS_NO_POLICY);
  eq(r.status, "fail", "RLS without policy should fail");
  assert(r.message.includes("policies"), "Should mention policies");
});

test("checkRLS: warns when only Drizzle schema present (no SQL)", () => {
  const r = checkRLS(ft({ "src/db/schema.ts": "export const users = pgTable('users', {});" }));
  eq(r.status, "warn");
});

test("checkRLS: skips when no schema or SQL files", () => {
  const r = checkRLS(new Map());
  eq(r.status, "skip");
});

// ── Security: checkSecrets ────────────────────────────────────────────────────

test("checkSecrets: catches OpenAI key in component", () => {
  const results = checkSecrets(CLIENT_WITH_SECRET);
  const fail = results.find((c) => c.status === "fail");
  assert(fail !== undefined, "Should catch OpenAI key");
  eq(fail.severity, "critical");
  assert(fail.file !== undefined);
});

test("checkSecrets: catches Stripe live key in client", () => {
  const results = checkSecrets(STRIPE_KEY_IN_CLIENT);
  const fail = results.find((c) => c.status === "fail");
  assert(fail !== undefined, "Should catch Stripe live key");
});

test("checkSecrets: passes when no secrets in client code", () => {
  const results = checkSecrets(CLIENT_CLEAN);
  assert(results.every((c) => c.status !== "fail"), "Should pass");
});

test("checkSecrets: ignores server-side files", () => {
  const serverFile = ft({
    "src/server/config.ts": `const key = "sk-abcdef1234567890abcdef1234567890abcdef";`,
  });
  const results = checkSecrets(serverFile);
  assert(results.every((c) => c.status !== "fail"), "Server files should not be checked");
});

// ── Security: checkOWASP ──────────────────────────────────────────────────────

test("checkOWASP: detects dangerouslySetInnerHTML (XSS)", () => {
  const results = checkOWASP(XSS_FILE);
  const xss = results.find((c) => c.id === "owasp-xss");
  assert(xss !== undefined && xss.status === "fail", "Should detect XSS");
  assert(xss.file !== undefined);
  assert(xss.line !== undefined);
});

test("checkOWASP: detects raw template literal in SQL (SQLi)", () => {
  const results = checkOWASP(SQLI_FILE);
  const sqli = results.find((c) => c.id === "owasp-sqli");
  assert(sqli !== undefined && sqli.status === "fail", "Should detect SQLi");
});

test("checkOWASP: detects POST form without CSRF token", () => {
  const results = checkOWASP(CSRF_FILE);
  const csrf = results.find((c) => c.id === "owasp-csrf");
  assert(csrf !== undefined && csrf.status === "fail", "Should detect CSRF risk");
});

test("checkOWASP: passes when no vulnerabilities", () => {
  const clean = ft({
    "src/components/Safe.tsx": `
      export function Safe({ text }: { text: string }) {
        return <div>{text}</div>;
      }
    `,
    "src/server/db.ts": `
      async function getUser(id: string) {
        return db.select().from(users).where(eq(users.id, id));
      }
    `,
  });
  const results = checkOWASP(clean);
  assert(results.every((c) => c.status !== "fail"), "Should pass clean code");
});

// ── Security: checkPackages ───────────────────────────────────────────────────

test("checkPackages: flags undeclared import (slopsquatting)", () => {
  const results = checkPackages(UNDECLARED_IMPORT);
  const fail = results.find((c) => c.status === "fail");
  assert(fail !== undefined, "Should flag undeclared package");
  assert(fail.message.includes("jsonwebtoken-secure"));
});

test("checkPackages: passes when all imports declared", () => {
  const results = checkPackages(ALL_DECLARED);
  assert(results.every((c) => c.status !== "fail"), "Should pass");
});

test("checkPackages: skips node builtins", () => {
  const withBuiltins = ft({
    "package.json": JSON.stringify({ dependencies: {} }),
    "src/server/fs.ts": `import { readFile } from "node:fs/promises";`,
  });
  const results = checkPackages(withBuiltins);
  assert(results.every((c) => c.status !== "fail"), "Built-ins should not be flagged");
});

test("checkPackages: skips when no package.json", () => {
  const results = checkPackages(new Map());
  eq(results[0]?.status, "skip");
});

// ── Security: checkCORS ───────────────────────────────────────────────────────

test("checkCORS: fails on wildcard origin", () => {
  const r = checkCORS(CORS_WILDCARD);
  eq(r.status, "fail");
  assert(r.file !== undefined);
});

test("checkCORS: passes with specific origin", () => {
  const r = checkCORS(CORS_SPECIFIC);
  eq(r.status, "pass");
});

// ── Security: checkStripe ─────────────────────────────────────────────────────

test("checkStripe: fails when Stripe used without constructEvent", () => {
  const r = checkStripe(STRIPE_NO_VERIFY);
  eq(r.status, "fail");
  assert(r.message.includes("constructEvent"));
});

test("checkStripe: passes when constructEvent is present", () => {
  const r = checkStripe(STRIPE_WITH_VERIFY);
  eq(r.status, "pass");
});

test("checkStripe: skips when Stripe not used", () => {
  const r = checkStripe(ft({ "src/server/index.ts": "import { Hono } from 'hono';" }));
  eq(r.status, "skip");
});

// ── Connection: checkApiContracts ─────────────────────────────────────────────

test("checkApiContracts: passes when calls match routes", () => {
  const files = ft({
    "src/routes/users.ts": `router.get("/api/users", handler);`,
    "src/components/UserList.tsx": `const res = await fetch("/api/users");`,
  });
  const r = checkApiContracts(files);
  eq(r.status, "pass");
});

test("checkApiContracts: fails when frontend calls unknown route", () => {
  const files = ft({
    "src/routes/users.ts": `router.get("/api/users", handler);`,
    "src/components/Profile.tsx": `const res = await fetch("/api/profile");`,
  });
  const r = checkApiContracts(files);
  eq(r.status, "fail");
  assert(r.detail.includes("/api/profile"));
});

test("checkApiContracts: skips when no routes or calls", () => {
  const r = checkApiContracts(new Map());
  eq(r.status, "skip");
});

// ── Connection: checkSchemaMatch ──────────────────────────────────────────────

test("checkSchemaMatch: passes when columns accessed exist in schema", () => {
  const files = ft({
    "src/db/schema.ts": `
      export const users = pgTable("users", {
        id: text("id").primaryKey(),
        email: text("email").notNull(),
      });
    `,
    "src/server/routes/users.ts": `
      import { users } from "../db/schema.js";
      const rows = await db.select({ id: users.id }).from(users);
    `,
  });
  const r = checkSchemaMatch(files);
  assert(r.status !== "fail", `Should pass, got: ${r.detail}`);
});

test("checkSchemaMatch: skips when no schema files", () => {
  const r = checkSchemaMatch(new Map());
  eq(r.status, "skip");
});

// ── Connection: checkAuthFlow ─────────────────────────────────────────────────

test("checkAuthFlow: passes on complete auth flow", () => {
  const files = ft({
    "src/routes/auth.ts": `router.post("/api/auth/login", handler);`,
    "src/middleware/auth.ts": `export const requireAuth = createMiddleware(...);`,
    "src/routes/users.ts": `
      router.use("/*", requireAuth);
      router.get("/api/users", handler);
    `,
    "src/middleware/error.ts": `throw new AppError(401, "Unauthorized");`,
  });
  const r = checkAuthFlow(files);
  eq(r.status, "pass");
});

test("checkAuthFlow: warns when no login endpoint", () => {
  const r = checkAuthFlow(ft({ "src/server/index.ts": "import { Hono } from 'hono';" }));
  eq(r.status, "warn");
});

test("checkAuthFlow: fails when login found but no auth middleware", () => {
  const files = ft({
    "src/routes/auth.ts": `router.post("/api/auth/login", handler);`,
    "src/routes/users.ts": `router.get("/api/users", handler);`,
  });
  const r = checkAuthFlow(files);
  eq(r.status, "fail");
});

// ── Connection: checkEnvVars ──────────────────────────────────────────────────

test("checkEnvVars: passes when all vars documented", () => {
  const files = ft({
    ".env.example": "DATABASE_URL=\nJWT_SECRET=\nSTRIPE_KEY=\n",
    "src/server/config.ts": `
      const db = process.env.DATABASE_URL;
      const jwt = process.env.JWT_SECRET;
      const stripe = process.env.STRIPE_KEY;
    `,
  });
  const r = checkEnvVars(files);
  eq(r.status, "pass");
});

test("checkEnvVars: fails when var missing from .env.example", () => {
  const files = ft({
    ".env.example": "DATABASE_URL=\n",
    "src/server/config.ts": `
      const db = process.env.DATABASE_URL;
      const secret = process.env.JWT_SECRET;
    `,
  });
  const r = checkEnvVars(files);
  eq(r.status, "fail");
  assert(r.detail.includes("JWT_SECRET"));
});

test("checkEnvVars: warns when no .env.example found", () => {
  const files = ft({ "src/config.ts": "const x = process.env.MY_SECRET;" });
  const r = checkEnvVars(files);
  eq(r.status, "warn");
});

test("checkEnvVars: skips standard vars (NODE_ENV, PORT)", () => {
  const files = ft({
    ".env.example": "",
    "src/index.ts": "const port = process.env.PORT;",
  });
  const r = checkEnvVars(files);
  assert(r.status !== "fail", "PORT is always-ok and should not fail");
});

// ── Connection: checkNoLocalhost ──────────────────────────────────────────────

test("checkNoLocalhost: fails on hardcoded localhost in production file", () => {
  const files = ft({ "src/lib/api.ts": `const BASE_URL = "http://localhost:3000/api";` });
  const r = checkNoLocalhost(files);
  eq(r.status, "fail");
  assert(r.detail.includes("localhost"));
});

test("checkNoLocalhost: passes when localhost only in test files", () => {
  const files = ft({ "src/lib/api.test.ts": `fetch("http://localhost:3000/api/users")` });
  const r = checkNoLocalhost(files);
  eq(r.status, "pass");
});

test("checkNoLocalhost: passes on clean production code", () => {
  const files = ft({ "src/lib/api.ts": `const BASE_URL = process.env.API_URL;` });
  const r = checkNoLocalhost(files);
  eq(r.status, "pass");
});

test("checkNoLocalhost: skips commented localhost lines", () => {
  const files = ft({
    "src/lib/api.ts": `
      // const BASE_URL = "http://localhost:3000"; // dev only
      const BASE_URL = process.env.API_URL;
    `,
  });
  const r = checkNoLocalhost(files);
  eq(r.status, "pass", "Commented localhost should not fail");
});

// ── autoFix ───────────────────────────────────────────────────────────────────

test("autoFix: returns fixed=true when agent resolves issue in round 1", async () => {
  // Start with a failing report (CORS wildcard)
  const corsFile = "src/server/app.ts";
  const fixedContent = `app.use(cors({ origin: "https://myapp.com" }));`;

  const fileStore = new Map<string, string>([[
    corsFile, `app.use(cors({ origin: "*" }));`,
  ]]);

  const mockAgent: FixAgent = async (_instruction, file, _content) => ({
    content: fixedContent,
    explanation: `Fixed wildcard CORS origin in ${file}`,
  });

  let recheckCalls = 0;
  const recheck = async (): Promise<SecurityReport | ConnectionReport> => {
    recheckCalls++;
    fileStore.set(corsFile, fixedContent); // simulate the fix took effect
    return {
      passed: true,
      checks: [{ id: "cors-wildcard", status: "pass", severity: "high", message: "Fixed" }],
    };
  };

  const result = await autoFix(
    {
      passed: false,
      checks: [{
        id: "cors-wildcard",
        status: "fail",
        severity: "high",
        file: corsFile,
        line: 2,
        message: "Wildcard CORS origin (*) found",
      }],
    },
    {
      projectId: "test-proj",
      recheck,
      reader: async (path) => fileStore.get(path) ?? null,
      writer: async (path, content) => { fileStore.set(path, content); },
      agent: mockAgent,
    },
  );

  assert(result.fixed, "Should be fixed");
  eq(result.rounds, 1);
  assert(result.changes.length > 0, "Should record a change");
  eq(result.changes[0]?.file, corsFile);
});

test("autoFix: returns immediately when report already passes", async () => {
  const result = await autoFix(
    { passed: true, checks: [{ id: "cors-wildcard", status: "pass", severity: "high", message: "OK" }] },
    {
      projectId: "test-proj",
      recheck: async () => ({ passed: true, checks: [] }),
      reader: async () => null,
      writer: async () => { /* noop */ },
      agent: async () => ({ content: "", explanation: "" }),
    },
  );

  assert(result.fixed, "Already passing report → fixed=true");
  eq(result.rounds, 0);
  eq(result.changes.length, 0);
});

test("autoFix: escalates when still failing after maxRounds", async () => {
  const failCheck = {
    id: "owasp-sqli",
    status: "fail" as const,
    severity: "critical" as const,
    file: "src/db.ts",
    line: 5,
    message: "SQL injection risk",
  };

  let rounds = 0;
  const result = await autoFix(
    { passed: false, checks: [failCheck] },
    {
      projectId: "test-proj",
      maxRounds: 3,
      recheck: async (): Promise<SecurityReport> => {
        rounds++;
        return { passed: false, checks: [failCheck] };
      },
      reader: async () => "const x = query(`SELECT ${id}`);",
      writer: async () => { /* noop */ },
      agent: async (_instruction, _file, content) => ({
        content,
        explanation: "attempted fix",
      }),
    },
  );

  assert(!result.fixed, "Should not be fixed");
  eq(result.rounds, 3);
  assert(result.escalated !== undefined, "Should have escalation message");
  assert(result.escalated.includes("owasp-sqli"), "Escalation should name the check");
});

test("autoFix: skips checks with no associated file", async () => {
  // Connection checks often have no file
  const agentCalled: boolean[] = [];
  const mockAgent: FixAgent = async (_i, _f, c) => {
    agentCalled.push(true);
    return { content: c, explanation: "no-op" };
  };

  const result = await autoFix(
    {
      passed: false,
      checks: [{ id: "no-localhost", status: "fail" as const, detail: "Hardcoded localhost in src/api.ts:3" }],
    },
    {
      projectId: "test-proj",
      recheck: async (): Promise<ConnectionReport> => ({
        passed: false,
        checks: [{ id: "no-localhost", status: "fail", detail: "Still failing" }],
      }),
      reader: async () => null,
      writer: async () => { /* noop */ },
      agent: mockAgent,
    },
  );

  // No file on ConnectionCheck → agent never called, escalated after rounds
  assert(!result.fixed, "No file-level fix possible");
  assert(result.escalated !== undefined, "Should escalate");
});

test("autoFix: records explanation from agent in changes", async () => {
  const file = "src/app.ts";
  const result = await autoFix(
    {
      passed: false,
      checks: [{
        id: "cors-wildcard",
        status: "fail",
        severity: "high",
        file,
        line: 1,
        message: "Wildcard CORS",
      }],
    },
    {
      projectId: "test-proj",
      recheck: async (): Promise<SecurityReport> => ({
        passed: true,
        checks: [{ id: "cors-wildcard", status: "pass", severity: "high", message: "Fixed" }],
      }),
      reader: async () => `cors({ origin: "*" })`,
      writer: async () => { /* noop */ },
      agent: async (_i, f, _c) => ({ content: `cors({ origin: "https://example.com" })`, explanation: `Fixed CORS in ${f}` }),
    },
  );

  assert(result.fixed);
  assert(result.changes[0]?.explanation.includes("Fixed CORS") === true, "Should include agent explanation");
});

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\nBuildForge Security + Connection Verifier — unit tests\n");
await run();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
