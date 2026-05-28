/**
 * Settings API — unit tests.
 *
 * Tests:
 *   - AES-256-GCM encrypt / decrypt round-trip
 *   - Env-var key validation
 *   - Integration provider catalogue
 *   - Billing plan credit limits
 *   - Full scenario: Connect Vercel → add env var → sync → billing → upgrade
 *
 * Zero DB / network / Stripe dependencies — all external calls are mocked.
 *
 * Usage:
 *   npx tsx src/server/routes/test-settings.ts
 */

import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../env-crypto.js";

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

async function run(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(68)} ... `);
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

// ── Encryption helpers ────────────────────────────────────────────────────────

function withKey(fn: () => void): void {
  const prev = process.env["ENCRYPTION_KEY"];
  // 32-byte random key expressed as 64 hex chars
  process.env["ENCRYPTION_KEY"] = randomBytes(32).toString("hex");
  try { fn(); } finally {
    if (prev === undefined) delete process.env["ENCRYPTION_KEY"];
    else process.env["ENCRYPTION_KEY"] = prev;
  }
}

// ── Tests: encrypt / decrypt ──────────────────────────────────────────────────

test("encrypt + decrypt round-trips a simple value", () => {
  withKey(() => {
    const plain = "my-secret-api-key-12345";
    const enc = encrypt(plain);
    const dec = decrypt(enc);
    eq(dec, plain, "Decrypted value must match original");
  });
});

test("encrypt + decrypt round-trips an empty string", () => {
  withKey(() => {
    const enc = encrypt("");
    eq(decrypt(enc), "");
  });
});

test("encrypt + decrypt round-trips unicode content", () => {
  withKey(() => {
    const plain = "日本語テスト 🔑 🔐";
    eq(decrypt(encrypt(plain)), plain);
  });
});

test("encrypt produces different ciphertext on each call (random IV)", () => {
  withKey(() => {
    const plain = "same-value";
    const a = encrypt(plain);
    const b = encrypt(plain);
    assert(a.iv !== b.iv, "IVs must differ");
    assert(a.encrypted !== b.encrypted, "Ciphertext must differ");
  });
});

test("encrypt produces base64-encoded iv, tag, encrypted fields", () => {
  withKey(() => {
    const enc = encrypt("hello");
    assert(enc.iv.length > 0, "iv must be non-empty");
    assert(enc.tag.length > 0, "tag must be non-empty");
    assert(enc.encrypted.length > 0, "encrypted must be non-empty");
    // All should be valid base64 (no spaces, correct alphabet)
    assert(/^[A-Za-z0-9+/]+=*$/.test(enc.iv), "iv must be base64");
    assert(/^[A-Za-z0-9+/]+=*$/.test(enc.tag), "tag must be base64");
  });
});

test("decrypt throws if auth tag is tampered (GCM integrity)", () => {
  withKey(() => {
    const enc = encrypt("secret");
    // Flip a byte in the tag
    const tagBuf = Buffer.from(enc.tag, "base64");
    tagBuf[0] = tagBuf[0] !== undefined ? tagBuf[0] ^ 0xff : 0xff;
    const tampered = { ...enc, tag: tagBuf.toString("base64") };
    let threw = false;
    try { decrypt(tampered); } catch { threw = true; }
    assert(threw, "Decryption with tampered tag must throw");
  });
});

test("getEncryptionKey throws on missing / invalid key", () => {
  const prev = process.env["ENCRYPTION_KEY"];
  process.env["ENCRYPTION_KEY"] = "tooshort";
  let threw = false;
  try { encrypt("x"); } catch { threw = true; }
  assert(threw, "Short key must throw");
  if (prev === undefined) delete process.env["ENCRYPTION_KEY"];
  else process.env["ENCRYPTION_KEY"] = prev;
});

test("getEncryptionKey throws when ENCRYPTION_KEY is not set", () => {
  const prev = process.env["ENCRYPTION_KEY"];
  delete process.env["ENCRYPTION_KEY"];
  let threw = false;
  try { encrypt("x"); } catch { threw = true; }
  assert(threw, "Missing key must throw");
  if (prev !== undefined) process.env["ENCRYPTION_KEY"] = prev;
});

// ── Tests: env var key validation regex ──────────────────────────────────────

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

test("env key validation: valid keys pass", () => {
  const valid = ["DATABASE_URL", "STRIPE_KEY", "MY_VAR_123", "_INTERNAL", "A"];
  for (const k of valid) {
    assert(ENV_KEY_RE.test(k), `Expected '${k}' to be valid`);
  }
});

test("env key validation: invalid keys fail", () => {
  const invalid = ["lowercase", "has-dash", "123starts", "", " SPACE", "has space"];
  for (const k of invalid) {
    assert(!ENV_KEY_RE.test(k), `Expected '${k}' to be invalid`);
  }
});

// ── Tests: integration provider catalogue ─────────────────────────────────────

interface ProviderInfo {
  id: string;
  name: string;
  authFields: string[];
  tier2Available: boolean;
  docsUrl: string;
}

function buildCatalogueFromEnv(): ProviderInfo[] {
  return [
    { id: "vercel",   name: "Vercel",   authFields: ["token", "teamId"],          tier2Available: Boolean(process.env["VERCEL_PROXY_TOKEN"]),   docsUrl: "https://vercel.com/docs/rest-api" },
    { id: "supabase", name: "Supabase", authFields: ["apiKey", "projectRef"],     tier2Available: Boolean(process.env["SUPABASE_PROXY_TOKEN"]), docsUrl: "https://supabase.com/docs/reference/api" },
    { id: "github",   name: "GitHub",   authFields: ["token", "orgId", "repoOwner"], tier2Available: Boolean(process.env["GITHUB_PROXY_TOKEN"]), docsUrl: "https://docs.github.com/rest" },
    { id: "railway",  name: "Railway",  authFields: ["token", "serviceId"],       tier2Available: Boolean(process.env["RAILWAY_PROXY_TOKEN"]),  docsUrl: "https://docs.railway.app/reference/public-api" },
  ];
}

test("provider catalogue has exactly 4 providers", () => {
  const providers = buildCatalogueFromEnv();
  eq(providers.length, 4, "Expected 4 providers");
});

test("provider catalogue includes all required fields", () => {
  const providers = buildCatalogueFromEnv();
  for (const p of providers) {
    assert(p.id.length > 0,          `${p.id}: id must be non-empty`);
    assert(p.name.length > 0,         `${p.id}: name must be non-empty`);
    assert(p.authFields.length > 0,   `${p.id}: authFields must be non-empty`);
    assert(p.docsUrl.startsWith("https://"), `${p.id}: docsUrl must be https`);
  }
});

test("provider catalogue: tier2Available false when no proxy tokens set", () => {
  const keys = ["VERCEL_PROXY_TOKEN", "SUPABASE_PROXY_TOKEN", "GITHUB_PROXY_TOKEN", "RAILWAY_PROXY_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }

  const providers = buildCatalogueFromEnv();
  assert(providers.every((p) => !p.tier2Available), "All should have tier2=false without proxy tokens");

  for (const k of keys) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test("provider catalogue: tier2Available true when proxy token is set", () => {
  const prev = process.env["VERCEL_PROXY_TOKEN"];
  process.env["VERCEL_PROXY_TOKEN"] = "tok_test";
  const providers = buildCatalogueFromEnv();
  const vercel = providers.find((p) => p.id === "vercel");
  assert(vercel?.tier2Available === true, "Vercel should be tier2 when token is set");
  if (prev === undefined) delete process.env["VERCEL_PROXY_TOKEN"];
  else process.env["VERCEL_PROXY_TOKEN"] = prev;
});

// ── Tests: billing plan limits ────────────────────────────────────────────────

const PLAN_CREDITS = { free: 100, pro: 2_000, enterprise: 50_000 } as const;
type Plan = keyof typeof PLAN_CREDITS;

function creditsRemaining(plan: Plan, used: number): number {
  return Math.max(0, PLAN_CREDITS[plan] - used);
}

function isOverLimit(plan: Plan, used: number): boolean {
  return used >= PLAN_CREDITS[plan];
}

test("billing: free plan has 100 credit limit", () => {
  eq(PLAN_CREDITS.free, 100);
});

test("billing: pro plan has 2000 credit limit", () => {
  eq(PLAN_CREDITS.pro, 2_000);
});

test("billing: enterprise plan has 50000 credit limit", () => {
  eq(PLAN_CREDITS.enterprise, 50_000);
});

test("billing: creditsRemaining never goes negative", () => {
  eq(creditsRemaining("free", 200), 0, "Should clamp at 0");
  eq(creditsRemaining("free", 100), 0, "Exactly at limit = 0 remaining");
  eq(creditsRemaining("free",  50), 50);
});

test("billing: isOverLimit correct at boundary", () => {
  assert(!isOverLimit("free",  99), "99 credits used → not over limit");
  assert( isOverLimit("free", 100), "100 credits used → at limit");
  assert( isOverLimit("free", 101), "101 credits used → over limit");
});

test("billing: upgrade plan is additive — higher plan means more credits", () => {
  assert(PLAN_CREDITS.pro > PLAN_CREDITS.free, "pro > free");
  assert(PLAN_CREDITS.enterprise > PLAN_CREDITS.pro, "enterprise > pro");
});

// ── Integration scenario: Connect → Env var → Sync → Billing → Upgrade ───────

interface MockIntegrationStore {
  connected: Map<string, { provider: string; tier: number }>;
}

interface MockEnvStore {
  vars: Map<string, { key: string; value: string; environment: string }>;
}

interface MockBillingStore {
  userId: string;
  plan: Plan;
  creditsUsed: number;
  stripeCustomerId: string | null;
}

class ScenarioRunner {
  integrations: MockIntegrationStore = { connected: new Map() };
  envStore: MockEnvStore = { vars: new Map() };
  billing: MockBillingStore;
  syncLog: string[] = [];

  constructor(userId: string) {
    this.billing = { userId, plan: "free", creditsUsed: 0, stripeCustomerId: null };
  }

  // Step 1: Connect Vercel
  connectVercel(token: string): { ok: boolean; tier: number } {
    if (!token.startsWith("vcel_")) return { ok: false, tier: 0 };
    this.integrations.connected.set("vercel", { provider: "vercel", tier: 1 });
    return { ok: true, tier: 1 };
  }

  // Step 2: Add env var (with encryption simulation)
  addEnvVar(key: string, value: string, environment = "production"): { ok: boolean; error?: string } {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return { ok: false, error: "Invalid key format" };
    if (this.envStore.vars.has(`${environment}:${key}`)) return { ok: false, error: "Key already exists" };
    // Simulate encryption by reversing the value (not real, just testable)
    this.envStore.vars.set(`${environment}:${key}`, { key, value: `enc:${value}`, environment });
    return { ok: true };
  }

  // Step 3: Sync to connected providers
  sync(environment = "production"): { synced: string[]; skipped: string[] } {
    const synced: string[] = [];
    const skipped: string[] = [];
    for (const [provider] of this.integrations.connected) {
      if (provider === "vercel") {
        this.syncLog.push(`Synced ${this.envStore.vars.size} var(s) to ${provider}`);
        synced.push(provider);
      } else {
        skipped.push(provider);
      }
    }
    return { synced, skipped };
  }

  // Step 4: Check billing
  checkBilling(): { plan: Plan; creditsRemaining: number; isOverLimit: boolean } {
    return {
      plan: this.billing.plan,
      creditsRemaining: creditsRemaining(this.billing.plan, this.billing.creditsUsed),
      isOverLimit: isOverLimit(this.billing.plan, this.billing.creditsUsed),
    };
  }

  // Step 5: Upgrade plan (mock Stripe)
  upgrade(newPlan: "pro" | "enterprise"): { ok: boolean; checkoutUrl?: string; error?: string } {
    if (this.billing.plan === newPlan) return { ok: false, error: "Already on that plan" };
    // Simulate Stripe checkout session creation
    const sessionId = `cs_test_${randomBytes(8).toString("hex")}`;
    const checkoutUrl = `https://checkout.stripe.com/pay/${sessionId}`;
    // After "payment", upgrade plan
    this.billing.plan = newPlan;
    this.billing.stripeCustomerId = `cus_test_${randomBytes(4).toString("hex")}`;
    return { ok: true, checkoutUrl };
  }
}

test("scenario: Connect Vercel with valid token succeeds (tier 1)", () => {
  const runner = new ScenarioRunner("user-1");
  const result = runner.connectVercel("vcel_abc123");
  assert(result.ok, "Connect should succeed");
  eq(result.tier, 1);
  assert(runner.integrations.connected.has("vercel"), "Vercel should be in connected integrations");
});

test("scenario: Connect Vercel with invalid token fails", () => {
  const runner = new ScenarioRunner("user-1");
  const result = runner.connectVercel("invalid-token");
  assert(!result.ok, "Should fail with invalid token");
});

test("scenario: Add env var succeeds with valid uppercase key", () => {
  const runner = new ScenarioRunner("user-1");
  const result = runner.addEnvVar("DATABASE_URL", "postgres://localhost/mydb");
  assert(result.ok, "Should succeed");
  assert(runner.envStore.vars.has("production:DATABASE_URL"), "Var should be stored");
});

test("scenario: Add env var fails with lowercase key", () => {
  const runner = new ScenarioRunner("user-1");
  const r = runner.addEnvVar("database_url", "value");
  assert(!r.ok, "Lowercase key should be rejected");
  assert(r.error !== undefined && r.error.includes("Invalid"), `Expected validation error, got: ${String(r.error)}`);
});

test("scenario: Add env var fails on duplicate key in same environment", () => {
  const runner = new ScenarioRunner("user-1");
  runner.addEnvVar("MY_KEY", "value1");
  const r2 = runner.addEnvVar("MY_KEY", "value2");
  assert(!r2.ok, "Duplicate key should be rejected");
});

test("scenario: Add env var succeeds for same key in different environments", () => {
  const runner = new ScenarioRunner("user-1");
  const r1 = runner.addEnvVar("API_KEY", "dev-value", "development");
  const r2 = runner.addEnvVar("API_KEY", "prod-value", "production");
  assert(r1.ok && r2.ok, "Same key in different envs should both succeed");
  eq(runner.envStore.vars.size, 2, "Should have 2 separate entries");
});

test("scenario: Sync pushes vars to Vercel when connected", () => {
  const runner = new ScenarioRunner("user-1");
  runner.connectVercel("vcel_abc123");
  runner.addEnvVar("API_KEY", "secret");
  runner.addEnvVar("DB_URL", "postgres://host/db");

  const result = runner.sync();
  assert(result.synced.includes("vercel"), "Vercel should be in synced list");
  eq(result.skipped.length, 0);
  assert(runner.syncLog.length > 0, "Sync log should have an entry");
  assert(runner.syncLog[0]?.includes("2 var") === true, "Should mention 2 vars");
});

test("scenario: Sync with no connected providers returns empty synced", () => {
  const runner = new ScenarioRunner("user-1");
  runner.addEnvVar("MY_KEY", "value");
  const result = runner.sync();
  eq(result.synced.length, 0);
});

test("scenario: Check billing shows free plan on new user", () => {
  const runner = new ScenarioRunner("user-1");
  const billing = runner.checkBilling();
  eq(billing.plan, "free");
  eq(billing.creditsRemaining, 100);
  assert(!billing.isOverLimit, "New user should not be over limit");
});

test("scenario: Check billing shows over-limit after heavy usage", () => {
  const runner = new ScenarioRunner("user-1");
  runner.billing.creditsUsed = 150;
  const billing = runner.checkBilling();
  assert(billing.isOverLimit, "Should be over limit at 150/100");
  eq(billing.creditsRemaining, 0);
});

test("scenario: Upgrade from free to pro succeeds", () => {
  const runner = new ScenarioRunner("user-1");
  const result = runner.upgrade("pro");
  assert(result.ok, "Upgrade should succeed");
  assert(result.checkoutUrl?.startsWith("https://checkout.stripe.com") === true, "Should return Stripe checkout URL");
  eq(runner.billing.plan, "pro");
  assert(runner.billing.stripeCustomerId !== null, "Should set Stripe customer ID");
});

test("scenario: Upgrading to same plan returns error", () => {
  const runner = new ScenarioRunner("user-1");
  runner.billing.plan = "pro";
  const result = runner.upgrade("pro");
  assert(!result.ok, "Should fail when already on that plan");
  assert(result.error?.includes("Already") === true, `Expected 'Already on that plan', got: ${String(result.error)}`);
});

test("scenario: After upgrade, credit limit increases", () => {
  const runner = new ScenarioRunner("user-1");
  runner.billing.creditsUsed = 95; // Near free limit

  const beforeUpgrade = runner.checkBilling();
  eq(beforeUpgrade.plan, "free");
  eq(beforeUpgrade.creditsRemaining, 5, "5 credits left on free");

  runner.upgrade("pro");
  // Simulate DB update after upgrade
  runner.billing.creditsUsed = 95; // same usage

  const afterUpgrade = creditsRemaining("pro", 95);
  eq(afterUpgrade, 2_000 - 95, "Pro plan should have far more credits");
});

test("full scenario: Connect → Env var → Sync → Billing → Upgrade", () => {
  const runner = new ScenarioRunner("user-full");

  // 1. Connect Vercel
  const connect = runner.connectVercel("vcel_test_token");
  assert(connect.ok, "Step 1: Connect Vercel");

  // 2. Add env vars
  const envResult1 = runner.addEnvVar("NEXT_PUBLIC_API_URL", "https://api.example.com");
  const envResult2 = runner.addEnvVar("STRIPE_SECRET_KEY", "sk_live_xxx");
  assert(envResult1.ok && envResult2.ok, "Step 2: Add env vars");
  eq(runner.envStore.vars.size, 2);

  // 3. Sync to platforms
  const sync = runner.sync();
  assert(sync.synced.includes("vercel"), "Step 3: Synced to Vercel");
  assert(runner.syncLog[0]?.includes("2 var") === true, "Step 3: Synced 2 vars");

  // 4. Check billing
  runner.billing.creditsUsed = 85;
  const billing = runner.checkBilling();
  eq(billing.plan, "free");
  eq(billing.creditsRemaining, 15);
  assert(!billing.isOverLimit);

  // 5. Upgrade to pro
  const upgrade = runner.upgrade("pro");
  assert(upgrade.ok, "Step 5: Upgrade to pro");
  assert(upgrade.checkoutUrl !== undefined, "Step 5: Got Stripe checkout URL");
  eq(runner.billing.plan, "pro");

  // Verify post-upgrade credit headroom
  const postUpgrade = creditsRemaining("pro", 85);
  assert(postUpgrade > 1_000, "Pro plan should have substantial remaining credits");
});

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\nBuildForge Settings API — unit tests\n");
await run();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
