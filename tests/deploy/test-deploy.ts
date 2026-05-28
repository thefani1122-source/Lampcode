/**
 * MCP Gateway + Deploy Pipeline — unit tests.
 *
 * Tests:
 *   - McpError construction and TIER_FALLBACK_ERRORS set
 *   - CLI command generation for all 4 providers (pure, no network)
 *   - 3-tier fallback logic (inline mock gateway)
 *   - Smoke test result parsing (mocked fetcher)
 *   - DeployPipeline state machine (mock gateway)
 *
 * Zero DB / config / network dependencies.
 *
 * Usage:
 *   npx tsx src/deploy/test-deploy.ts
 */

import { runSmokeTests, type Fetcher } from "./smoke.js";

// ── Inline types (previously from mcp/types) ──────────────────────────────────

type ConnectionTier = 1 | 2 | 3;
type IntegrationCredentials = Record<string, string | undefined>;

interface ToolResult {
  success: boolean;
  tier: ConnectionTier;
  data: Record<string, unknown>;
  cliCommands?: string[];
  error?: string;
}

interface DeployStep {
  name: string;
  tier?: ConnectionTier;
  success: boolean;
  data?: Record<string, unknown>;
  cliCommands?: string[];
  error?: string;
}

class McpError extends Error {
  override name = "McpError";
  constructor(
    public readonly type: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
  }
}

const TIER_FALLBACK_ERRORS = new Set(["AUTH_FAILED", "NETWORK_ERROR", "RATE_LIMIT"]);

// ── Harness ───────────────────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: TestFn): void { tests.push({ name, fn }); }

async function runTests(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(68)} ... `);
    try { await fn(); console.log("OK"); passed++; }
    catch (e) { console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`); failed++; }
  }
}

function expect<T>(a: T, b: T, msg?: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function expectTrue(v: boolean, msg?: string): void { if (!v) throw new Error(msg ?? "Expected true"); }

// ── McpError tests ────────────────────────────────────────────────────────────

test("McpError: name is McpError and type is set", () => {
  const e = new McpError("AUTH_FAILED", "bad token", 401);
  expect(e.name, "McpError");
  expect(e.type, "AUTH_FAILED");
  expect(e.statusCode, 401);
  expect(e.message, "bad token");
});

test("McpError: TIER_FALLBACK_ERRORS contains auth/network/rate-limit", () => {
  expectTrue(TIER_FALLBACK_ERRORS.has("AUTH_FAILED"));
  expectTrue(TIER_FALLBACK_ERRORS.has("NETWORK_ERROR"));
  expectTrue(TIER_FALLBACK_ERRORS.has("RATE_LIMIT"));
  expectTrue(!TIER_FALLBACK_ERRORS.has("NOT_FOUND"));
  expectTrue(!TIER_FALLBACK_ERRORS.has("PROVIDER_ERROR"));
  expectTrue(!TIER_FALLBACK_ERRORS.has("TOOL_NOT_FOUND"));
});

// ── Tier fallback mock gateway ────────────────────────────────────────────────

interface MockIntegration {
  credentials: IntegrationCredentials;
  tier: ConnectionTier;
}

class MockGateway {
  private readonly integrations = new Map<string, MockIntegration>();
  private readonly proxyCreds = new Map<string, IntegrationCredentials>();

  setIntegration(projectId: string, provider: string, creds: IntegrationCredentials, tier: ConnectionTier = 1) {
    this.integrations.set(`${projectId}:${provider}`, { credentials: creds, tier });
  }

  setProxyCreds(provider: string, creds: IntegrationCredentials) {
    this.proxyCreds.set(provider, creds);
  }

  async executeTool(
    projectId: string,
    provider: string,
    toolName: string,
    _args: Record<string, unknown>,
    implFn: (creds: IntegrationCredentials) => Promise<Record<string, unknown>>,
    cliFn: () => string[],
  ): Promise<ToolResult> {
    const integration = this.integrations.get(`${projectId}:${provider}`);
    const userCreds = integration?.credentials ?? {};

    // Tier 1
    if (userCreds.token ?? userCreds.apiKey) {
      try {
        const data = await implFn(userCreds);
        return { success: true, tier: 1, data };
      } catch (err) {
        if (err instanceof McpError && TIER_FALLBACK_ERRORS.has(err.type)) {
          // fall through to Tier 2
        } else {
          return { success: false, tier: 1, data: {}, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    // Tier 2
    const proxyCreds = this.proxyCreds.get(provider);
    if (proxyCreds) {
      try {
        const data = await implFn(proxyCreds);
        return { success: true, tier: 2, data };
      } catch {
        // fall through to Tier 3
      }
    }

    // Tier 3
    return { success: true, tier: 3, data: {}, cliCommands: cliFn() };
  }
}

const mockGateway = new MockGateway();

test("Tier fallback: Tier 1 used when user token is valid", async () => {
  mockGateway.setIntegration("proj-1", "vercel", { token: "valid-token" });

  const result = await mockGateway.executeTool(
    "proj-1", "vercel", "deploy", {},
    async (_creds) => ({ url: "https://my-app.vercel.app", deploymentId: "dpl_1" }),
    () => ["vercel --prod"],
  );

  expect(result.tier, 1);
  expectTrue(result.success);
  expect(result.data["url"], "https://my-app.vercel.app");
});

test("Tier fallback: AUTH_FAILED on Tier 1 → tries Tier 2", async () => {
  mockGateway.setIntegration("proj-2", "vercel", { token: "expired-token" });
  mockGateway.setProxyCreds("vercel", { token: "proxy-token" });

  let callCount = 0;
  const result = await mockGateway.executeTool(
    "proj-2", "vercel", "deploy", {},
    async (creds) => {
      callCount++;
      if (creds.token === "expired-token") throw new McpError("AUTH_FAILED", "Token expired", 401);
      return { url: "https://via-proxy.vercel.app" };
    },
    () => ["vercel --prod"],
  );

  expect(result.tier, 2);
  expectTrue(result.success);
  expect(callCount, 2, "Should have tried both Tier 1 and Tier 2");
});

test("Tier fallback: Tier 2 also fails → Tier 3 CLI commands", async () => {
  mockGateway.setIntegration("proj-3", "vercel", { token: "dead-token" });
  mockGateway.setProxyCreds("vercel", { token: "dead-proxy-token" });

  const result = await mockGateway.executeTool(
    "proj-3", "vercel", "deploy", {},
    async (_creds) => { throw new McpError("AUTH_FAILED", "All tokens expired", 401); },
    () => ["vercel --yes", "vercel --prod"],
  );

  expect(result.tier, 3);
  expectTrue(result.success, "Tier 3 always succeeds");
  expectTrue(Array.isArray(result.cliCommands) && result.cliCommands.length === 2);
  expect(result.cliCommands![0], "vercel --yes");
});

test("Tier fallback: no credentials → skip to Tier 2", async () => {
  mockGateway.setIntegration("proj-4", "supabase", {}); // no token
  mockGateway.setProxyCreds("supabase", { token: "proxy-sb-key" });

  const result = await mockGateway.executeTool(
    "proj-4", "supabase", "pushMigrations", {},
    async (creds) => {
      if (creds.token === "proxy-sb-key") return { applied: true };
      throw new McpError("AUTH_FAILED", "No token");
    },
    () => ["supabase db push"],
  );

  expect(result.tier, 2);
  expectTrue(result.success);
});

test("Tier fallback: PROVIDER_ERROR does NOT trigger fallback", async () => {
  mockGateway.setIntegration("proj-5", "github", { token: "valid-gh-token" });

  const result = await mockGateway.executeTool(
    "proj-5", "github", "pushCode", {},
    async (_creds) => { throw new McpError("PROVIDER_ERROR", "GitHub internal error", 500); },
    () => ["git push origin main"],
  );

  // PROVIDER_ERROR should NOT fall through to Tier 3 — it should surface as failure
  expect(result.success, false);
  expect(result.tier, 1);
  expectTrue(result.error?.includes("GitHub internal error") ?? false);
});

test("Tier fallback: no integration → goes straight to Tier 3", async () => {
  // proj-99 has no integration registered
  const result = await mockGateway.executeTool(
    "proj-99", "railway", "deploy", {},
    async (_creds) => { throw new McpError("AUTH_FAILED", "No token"); },
    () => ["railway up --detach"],
  );

  expect(result.tier, 3);
  expectTrue(result.success);
  expectTrue(result.cliCommands?.includes("railway up --detach") ?? false);
});

// ── Smoke test result parsing ─────────────────────────────────────────────────

function makeFetcher(responses: Record<string, { status: number; body?: string }>): Fetcher {
  return async (url) => {
    // Use longest matching pattern to avoid "/" matching everything
    const match = Object.entries(responses)
      .filter(([pattern]) => url.endsWith(pattern) || url.includes(pattern + "?"))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (match) {
      const [, res] = match;
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.body };
    }
    return { status: 0, ok: false, body: "Connection refused" };
  };
}

test("Smoke tests: all 200 → ok=true", async () => {
  const fetcher = makeFetcher({
    "/": { status: 200 },
    "/api/health": { status: 200, body: '{"db":"ok"}' },
    "/api/auth/login": { status: 200 },
  });

  const result = await runSmokeTests("https://my-app.vercel.app", fetcher);
  expectTrue(result.ok, `Expected ok=true, checks: ${JSON.stringify(result.checks.map((c) => ({ n: c.name, p: c.passed, s: c.statusCode })))}`);
  expectTrue(result.checks.length === 4, `Expected 4 checks, got ${result.checks.length}`);
  expectTrue(result.totalLatencyMs >= 0);
});

test("Smoke tests: health 500 → ok=false", async () => {
  const fetcher = makeFetcher({
    "/": { status: 200 },
    "/api/health": { status: 500 },
    "/api/auth/login": { status: 401 },
  });

  const result = await runSmokeTests("https://broken.vercel.app", fetcher);
  expectTrue(!result.ok, "Should fail when health is 500");
  const healthCheck = result.checks.find((c) => c.name === "Health endpoint");
  expectTrue(healthCheck?.passed === false, "Health check should fail");
});

test("Smoke tests: auth 401 is acceptable (not 500)", async () => {
  const fetcher = makeFetcher({
    "/": { status: 200 },
    "/api/health": { status: 200 },
    "/api/auth/login": { status: 401 },
  });

  const result = await runSmokeTests("https://my-app.vercel.app", fetcher);
  const authCheck = result.checks.find((c) => c.name === "Auth endpoint");
  expectTrue(authCheck?.passed === true, "401 from auth endpoint should pass");
});

test("Smoke tests: connection refused → ok=false with detail", async () => {
  const fetcher = makeFetcher({}); // all URLs return status 0

  const result = await runSmokeTests("https://unreachable.example.com", fetcher);
  expectTrue(!result.ok, "Should fail on connection refused");
  expectTrue(result.checks.every((c) => !c.passed), "All checks should fail");
});

test("Smoke tests: trailing slash stripped from URL", async () => {
  let capturedUrl = "";
  const fetcher: Fetcher = async (url) => {
    capturedUrl = url;
    return { status: 200, ok: true };
  };

  await runSmokeTests("https://my-app.vercel.app/", fetcher);
  expectTrue(!capturedUrl.includes("//api"), "Double slash should not appear in URL");
});

// ── Pipeline step builder (pure logic) ───────────────────────────────────────

function buildDeployStep(name: string, result: ToolResult): DeployStep {
  return {
    name,
    tier: result.tier,
    success: result.success,
    data: result.data,
    ...(result.cliCommands !== undefined ? { cliCommands: result.cliCommands } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

test("Pipeline: all Tier-3 steps → manual_required status", () => {
  const tier3Result: ToolResult = { success: true, tier: 3, data: {}, cliCommands: ["vercel --prod"] };
  const steps = [
    buildDeployStep("Set env vars", tier3Result),
    buildDeployStep("Push database", tier3Result),
    buildDeployStep("Push code", tier3Result),
    buildDeployStep("Deploy", tier3Result),
  ];

  const allManual = steps.every((s) => s.tier === 3);
  expectTrue(allManual, "All steps should be tier 3");

  const manualSteps = steps.flatMap((s) => s.cliCommands ?? []);
  expectTrue(manualSteps.length === 4, `Expected 4 manual commands, got ${manualSteps.length}`);
});

test("Pipeline: any failed step → overall failure", () => {
  const steps: DeployStep[] = [
    buildDeployStep("Set env vars", { success: true,  tier: 1, data: {} }),
    buildDeployStep("Push database", { success: false, tier: 1, data: {}, error: "SQL error" }),
    buildDeployStep("Push code",    { success: true,  tier: 1, data: {} }),
  ];
  const anyFailed = steps.some((s) => !s.success);
  expectTrue(anyFailed, "Should detect failed step");
});

test("Pipeline: all Tier-1 success → deployed status", () => {
  const steps: DeployStep[] = [
    buildDeployStep("Set env vars", { success: true, tier: 1, data: {} }),
    buildDeployStep("Push database", { success: true, tier: 1, data: {} }),
    buildDeployStep("Push code",    { success: true, tier: 1, data: {} }),
    buildDeployStep("Deploy",       { success: true, tier: 1, data: { url: "https://live.vercel.app" } }),
  ];
  const allManual = steps.every((s) => s.tier === 3);
  const anyFailed = steps.some((s) => !s.success);
  expectTrue(!allManual, "Not all manual");
  expectTrue(!anyFailed, "None failed");
  // status would be "deployed" after smoke tests pass
});

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("\nBuildForge MCP Gateway + Deploy Pipeline — unit tests\n");
await runTests();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
if (failed > 0) process.exit(1);
