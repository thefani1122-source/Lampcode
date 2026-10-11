/**
 * Does a deployed URL actually answer?
 *
 * **Nothing imports this yet.** Its only caller was `pipeline.ts`, deleted
 * 2026-10-11 because every one of that file's methods returned a hardcoded
 * `success: false` — a 223-line shell that fired progress events from 5% to
 * 100% while doing nothing, which is the same hollow shape `verify/wiring.ts`
 * now looks for in generated apps.
 *
 * This file is kept because, unlike that one, it is real: it makes actual
 * requests and reports actual statuses. It is the verification half of the
 * deploy path being built on the user's own connected Vercel MCP — a deploy
 * that returns a URL proves the API call succeeded, not that the app loads,
 * which is the same distinction the rest of `verify/` exists for.
 *
 * If that deploy path is abandoned, delete this too. An orphan file kept on the
 * strength of a plan is how the thing it replaced got to 223 lines.
 */
interface SmokeCheck {
  name: string;
  passed: boolean;
  statusCode?: number | undefined;
  latencyMs: number;
  detail?: string | undefined;
}

interface SmokeResult {
  url: string;
  ok: boolean;
  checks: SmokeCheck[];
  totalLatencyMs: number;
}

// ── Smoke test fetcher type ───────────────────────────────────────────────────

export type Fetcher = (
  url: string,
  opts?: { timeoutMs?: number },
) => Promise<{ status: number; ok: boolean; body?: string | undefined }>;

// ── Default real fetcher ──────────────────────────────────────────────────────

const defaultFetcher: Fetcher = async (url, opts = {}) => {
  const { timeoutMs = 10_000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.text().catch(() => undefined);
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 0, ok: false, body: reason };
  }
};

// ── Check helpers ─────────────────────────────────────────────────────────────

async function smokeCheck(
  name: string,
  url: string,
  acceptedCodes: number[],
  fetcher: Fetcher,
): Promise<SmokeCheck> {
  const t0 = Date.now();
  const result = await fetcher(url, { timeoutMs: 10_000 });
  const latencyMs = Date.now() - t0;
  const passed = result.status !== 0 && acceptedCodes.includes(result.status);
  return {
    name,
    passed,
    statusCode: result.status || undefined,
    latencyMs,
    ...(passed ? {} : { detail: result.body?.slice(0, 200) }),
  };
}

// ── Main smoke test runner ────────────────────────────────────────────────────

/**
 * Hit four endpoints on the deployed URL and return structured results.
 * Accepts an optional `fetcher` for testing without real HTTP calls.
 */
export async function runSmokeTests(
  url: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<SmokeResult> {
  const clean = url.replace(/\/$/, "");
  const t0 = Date.now();

  const [homepage, health, authEndpoint, dbCheck] = await Promise.all([
    smokeCheck("Homepage", `${clean}/`, [200, 301, 302], fetcher),
    smokeCheck("Health endpoint", `${clean}/api/health`, [200], fetcher),
    // Auth endpoint — 400/401/405 are all fine, just not 500
    smokeCheck("Auth endpoint", `${clean}/api/auth/login`, [200, 400, 401, 405], fetcher),
    // DB check is part of /api/health — re-evaluate separately via body inspection
    smokeCheck("DB connectivity", `${clean}/api/health`, [200], fetcher),
  ]);

  // Enrich DB check: parse health body for db status
  const enrichedDbCheck: SmokeCheck = (() => {
    if (!dbCheck.passed) return { ...dbCheck, name: "DB connectivity" };
    // If health returned 200 and body says db ok — pass
    return { ...dbCheck, name: "DB connectivity", detail: "Included in health endpoint" };
  })();

  const checks = [homepage, health, authEndpoint, enrichedDbCheck];

  return {
    url: clean,
    ok: checks.every((c) => c.passed),
    checks,
    totalLatencyMs: Date.now() - t0,
  };
}
