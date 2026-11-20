/**
 * Post-deploy HTTP verification for Vercel.
 *
 * `deployToVercel` calls this only after Vercel reports READY. Its result is
 * part of the deployment verdict: an unavailable endpoint, failed request or
 * verifier exception must never be converted into a successful deployment.
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
    // Keep the abort timer active until the response body is consumed too;
    // fetch() can resolve headers while the body stream is still stalled.
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 0, ok: false, body: reason };
  } finally {
    clearTimeout(timer);
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
 * Check the deployed homepage and only the optional API routes declared by the app.
 * Accepts an optional `fetcher` for testing without real HTTP calls.
 */
export interface SmokeTestOptions {
  /** Default true for existing Vite/Hono/FastAPI deploys. */
  checkHealth?: boolean;
  /** Default true for existing Vite/Hono/FastAPI deploys. */
  checkAuth?: boolean;
}

/**
 * Hit the homepage and the API routes this app actually exposes.
 * Legacy deploy shapes keep their existing health/auth checks by default.
 */
export async function runSmokeTests(
  url: string,
  fetcher: Fetcher = defaultFetcher,
  options: SmokeTestOptions = {},
): Promise<SmokeResult> {
  const clean = url.replace(/\/$/, "");
  const t0 = Date.now();
  const checkHealth = options.checkHealth ?? true;
  const checkAuth = options.checkAuth ?? true;

  const [homepage, health, authEndpoint] = await Promise.all([
    smokeCheck("Homepage", `${clean}/`, [200, 301, 302], fetcher),
    checkHealth ? smokeCheck("Health endpoint", `${clean}/api/health`, [200], fetcher) : Promise.resolve(undefined),
    checkAuth
      ? smokeCheck("Auth endpoint", `${clean}/api/auth/login`, [200, 400, 401, 405], fetcher)
      : Promise.resolve(undefined),
  ]);

  const checks: SmokeCheck[] = [homepage];
  if (health) checks.push(health)
  if (authEndpoint) checks.push(authEndpoint)

  return {
    url: clean,
    ok: checks.every((c) => c.passed),
    checks,
    totalLatencyMs: Date.now() - t0,
  };
}
