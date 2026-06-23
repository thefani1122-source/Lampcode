import { Sandbox } from "e2b";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { createRedis } from "../lib/redis.js";
import type { FullstackFramework } from "../agents/prompt-builder.js";

/**
 * E2B cloud sandbox preview for fullstack builds.
 *
 * Unlike the in-browser WebContainer/Sandpack preview (JS/TS only), E2B runs a
 * real Linux VM, so it can host backends in any language the LLM generates
 * (Node, Python, Go, etc). Sandboxes are kept alive per project (not per build
 * session) and reused across follow-up builds via E2B's pause/resume — the
 * Lovable pattern — so we avoid paying the npm-install + cold-start cost on
 * every single prompt.
 */

export type PreviewLogCallback = (line: string) => void;

const PROJECT_DIR = "/home/user/app";
// Sandbox lifetime per session. Set on create AND resume, and refreshed every
// build turn (heartbeat). Generous so an active testing session never expires
// mid-use; idle sandboxes are paused on WS disconnect well before this.
const SANDBOX_TIMEOUT_MS = Number(process.env["SANDBOX_RUN_TIMEOUT_MS"] ?? 60 * 60 * 1000); // 1 hour

// Custom template (see e2b.Dockerfile / e2b.toml) that pre-installs Node,
// frontend deps, and a baseline Vite/React scaffold. Falls back to the stock
// "base" template if no custom template has been built/configured yet.
// Railway Env Var: E2B_TEMPLATE_ID=lampcode-vite
const TEMPLATE_ID = process.env["E2B_TEMPLATE_ID"] ?? "lampcode-vite";

/**
 * Returns the E2B sandbox template ID for the given fullstack framework.
 *
 * TODO: Next.js and TanStack Start each need their own E2B template:
 *   - nextjs: run `next dev` on :3000, bake Next.js + node_modules
 *   - tanstack: run `vinxi dev` on :3000 (or whatever @tanstack/start uses), bake deps
 * Once those templates are built, replace the TEMPLATE_ID fallback here with the
 * real template IDs (set via Railway env vars NEXTJS_TEMPLATE_ID, TANSTACK_TEMPLATE_ID).
 * Until then, Next.js and TanStack builds use the React template — generated code
 * will be correct but the preview will show the React scaffold instead.
 */
export function selectTemplate(framework: FullstackFramework): string {
  switch (framework) {
    case "nextjs":
      // TODO: build a Next.js E2B template (next dev on :3000) and set NEXTJS_TEMPLATE_ID
      return process.env["NEXTJS_TEMPLATE_ID"] ?? TEMPLATE_ID;
    case "tanstack":
      // TODO: build a TanStack Start E2B template (vinxi dev on :3000) and set TANSTACK_TEMPLATE_ID
      return process.env["TANSTACK_TEMPLATE_ID"] ?? TEMPLATE_ID;
    default:
      return TEMPLATE_ID;
  }
}

// E2B sandbox snapshots (created on pause) expire after 30 days. We key the
// Redis record's TTL slightly below that — 25 days — so we never hand back a
// sandboxId whose underlying snapshot has already been garbage-collected.
const SANDBOX_REDIS_TTL_SECONDS = 25 * 24 * 60 * 60;

const READY_POLL_INTERVAL_MS = 2_000;

/** Next.js/TanStack `next dev`/`vinxi dev` cold-compiles on first start (45–90 s). React/Vite is much faster (< 30 s). */
function readyPollTimeoutMs(framework: FullstackFramework): number {
  return framework === "nextjs" || framework === "tanstack" ? 90_000 : 30_000;
}

const redis = createRedis();

function redisKey(projectId: string): string {
  return `e2b:sandbox:${projectId}`;
}

function frameworkRedisKey(projectId: string): string {
  return `e2b:framework:${projectId}`;
}

// Live Sandbox object references for the current process lifetime — needed so
// follow-up builds in the same process can write files directly without a
// network round-trip to resume. Lost on restart; Redis is the durable record.
const sandboxes = new Map<string, Sandbox>();
// Tracks which fullstack framework each live sandbox was created for, so
// framework-aware helpers (port/start-command) work without extra parameters
// at call sites that only have a projectId (resume-on-open, follow-up writes).
const sandboxFrameworks = new Map<string, FullstackFramework>();

/** Port the dev server listens on inside the sandbox. */
function devPort(framework: FullstackFramework): number {
  return framework === "nextjs" || framework === "tanstack" ? 3000 : 5173;
}

/** Shell command that starts the dev server. */
function devStartCommand(framework: FullstackFramework): string {
  switch (framework) {
    case "nextjs":
    case "tanstack":
      // package.json `dev` script already includes --port 3000 / --hostname 0.0.0.0
      return "npm run dev";
    default:
      return "npx vite --host 0.0.0.0 --port 5173";
  }
}

/** Process name pattern used to kill a stale dev-server before restarting. */
function devKillPattern(framework: FullstackFramework): string {
  return framework === "nextjs" ? "next" : framework === "tanstack" ? "vinxi" : "vite";
}

// Per-project preview Supabase override (the project owner's OWN connected
// Supabase). Set at build start; used by writePreviewEnv before Vite boots.
const projectPreviewEnv = new Map<string, { url: string; anonKey: string; serviceKey?: string }>();

/** Point a project's preview at the owner's connected Supabase (anon key only). */
export function setProjectPreviewEnv(
  projectId: string,
  creds: { url: string; anonKey: string; serviceKey?: string } | null,
): void {
  if (creds) projectPreviewEnv.set(projectId, creds);
  else projectPreviewEnv.delete(projectId);
}

// In-flight pre-warm promises, keyed by projectId. When a build starts we kick
// off sandbox boot in the background (parallel with AI generation); the
// preview-write path awaits this so it never races into creating a second
// sandbox for the same project.
const warmingSandboxes = new Map<string, Promise<Sandbox>>();

/**
 * Polls the preview URL until it responds or the timeout elapses. The dev
 * server is started in the background with no readiness signal, so without
 * this we'd hand the user a URL that may still be 404ing/connection-refused.
 * Any HTTP response (even an error status) means the server is up and routing.
 */
async function waitForServerReady(url: string, framework: FullstackFramework): Promise<boolean> {
  const deadline = Date.now() + readyPollTimeoutMs(framework);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status < 500) return true;
    } catch {
      // Connection refused / not yet listening — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

const VITE_CONFIG_FILENAMES = ["vite.config.ts", "vite.config.js"];

// Injected into the generated vite.config.ts server block so the E2B preview
// works end to end:
//  - allowedHosts: Vite 5+ rejects requests from hosts it doesn't recognize,
//    but E2B serves the preview from a dynamic `*.e2b.app` subdomain.
//  - hmr.clientPort 443 + protocol wss: the preview iframe loads over HTTPS,
//    but Vite otherwise advertises `ws://localhost:5173` for HMR — the browser
//    can't reach that, so live-reload silently dies. Pinning the client to the
//    public HTTPS port makes HMR connect back through E2B's TLS endpoint.
const HMR_SNIPPET = "hmr: { clientPort: 443, protocol: 'wss' },";
const ALLOWED_HOSTS_SNIPPET = "allowedHosts: true,";

/**
 * Forces the generated vite.config.ts to be E2B-preview-safe. The LLM doesn't
 * reliably emit `allowedHosts`/`hmr` (it often writes a custom `server: {}`
 * block with just a proxy), so every write is patched in-place here, injecting
 * only the pieces that are missing and preserving everything else the LLM set.
 */
function patchViteConfig(files: Record<string, string>, log: PreviewLogCallback): void {
  for (const filename of VITE_CONFIG_FILENAMES) {
    const content = files[filename];
    if (content === undefined) continue;

    const needsAllowedHosts = !/allowedHosts/.test(content);
    const needsHmr = !/\bhmr\s*:/.test(content);
    if (!needsAllowedHosts && !needsHmr) return;

    const additions = [
      needsAllowedHosts ? ALLOWED_HOSTS_SNIPPET : null,
      needsHmr ? HMR_SNIPPET : null,
    ].filter(Boolean);

    let patched: string;
    if (/server\s*:\s*\{/.test(content)) {
      patched = content.replace(
        /server\s*:\s*\{/,
        (m) => `${m}\n    ${additions.join("\n    ")}`,
      );
    } else if (/defineConfig\(\s*\{/.test(content)) {
      patched = content.replace(
        /defineConfig\(\s*\{/,
        (m) => `${m}\n  server: { ${additions.join(" ")} },`,
      );
    } else {
      continue;
    }

    log(`Patched ${filename} for E2B preview (${additions.length} setting(s) injected)`);
    files[filename] = patched;
    return;
  }
}

// The preview template already ships known-good versions of these files (with
// the right Vite host/allowedHosts/HMR config and pre-installed node_modules).
// Overwriting them with LLM-generated copies is what broke the preview: a bad
// vite.config restarts/crashes Vite, and a different package.json triggers a
// runtime `npm install` that disrupts the already-running dev server ("no
// service on port 5173"). So we never write these into the sandbox — the model
// only contributes src/** app files on top of the baked baseline.
const BAKED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lockb",
  // React/Vite template config — must not be overwritten (allowedHosts/HMR would break)
  "vite.config.ts",
  "vite.config.js",
  "tsconfig.json",
  "tsconfig.node.json",
  "index.html",
  // Next.js template config
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  // TanStack Start / Vinxi config (controls server port — must stay as baked)
  "app.config.ts",
  // The model emits an empty .env; we write the real one (with the preview
  // Supabase creds) ourselves, before the dev server starts, in writePreviewEnv().
  ".env",
  ".env.example",
  // Foundation utility files — the LLM imports these but must not overwrite them.
  "src/lib/utils.ts",
  "src/lib/queryClient.ts",
]);

/**
 * Writes the preview `.env` with the Supabase credentials the generated app
 * needs to initialise its client. Must run BEFORE the dev server starts — Vite
 * only reads VITE_* env at startup, so injecting after boot wouldn't take.
 * No-op if no preview Supabase project is configured.
 */
async function writePreviewEnv(sandbox: Sandbox, projectId: string, log: PreviewLogCallback): Promise<void> {
  // Prefer the USER'S own connected Supabase project (set per-project at build
  // start) over the shared preview project — so each user's app runs on their
  // own database. The anon key is public/RLS-safe.
  const override = projectPreviewEnv.get(projectId);
  let url = override?.url ?? config.PREVIEW_SUPABASE_URL;
  let anon = override?.anonKey ?? config.PREVIEW_SUPABASE_ANON_KEY;
  if (override) log("Using the project owner's connected Supabase for the preview");

  // SAFETY: never point a generated preview app at Lampcode's OWN Supabase
  // project — test sign-ups/data would pollute the real product. Drop it.
  if (url && config.SUPABASE_URL && url === config.SUPABASE_URL) {
    logger.error({ url }, "[e2b] REFUSING preview Supabase = platform SUPABASE_URL (data-safety)");
    log("⚠️ Preview Supabase = platform Supabase — skipping Supabase env. Use a separate preview project.");
    url = undefined;
    anon = undefined;
  }

  const serviceKey = override?.serviceKey ?? config.PREVIEW_SUPABASE_SERVICE_KEY;
  const mongoUri = config.PREVIEW_MONGODB_URI;

  // VITE_* → frontend (import.meta.env); plain keys → Node backend (process.env
  // via tsx --env-file). SERVICE/JWT/MONGO keys have NO VITE_ prefix, so Vite
  // never exposes them to the browser. A JWT secret is always provided so
  // MongoDB apps can do custom auth.
  let env = "";
  if (url && anon) {
    env +=
      `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n` +
      `SUPABASE_URL=${url}\nSUPABASE_ANON_KEY=${anon}\n` +
      (serviceKey ? `SUPABASE_SERVICE_KEY=${serviceKey}\nSUPABASE_SERVICE_ROLE_KEY=${serviceKey}\n` : "");
    if (serviceKey) log("Backend has service-role access to Supabase");
  }
  if (mongoUri) {
    env += `MONGODB_URI=${mongoUri}\n`;
    log("Backend has a MongoDB connection (MONGODB_URI)");
  }
  // Stable per-project secret for custom (MongoDB) JWT auth.
  env += `JWT_SECRET=lampcode_${projectId}\n`;

  if (!env.trim()) {
    log("No preview DB configured — skipping .env injection");
    return;
  }
  try {
    await sandbox.files.write(`${PROJECT_DIR}/.env`, env);
    log("Injected preview Supabase credentials into .env");
  } catch (err) {
    logger.warn({ err }, "[e2b] Failed to write preview .env");
  }
}

async function writeFiles(
  sandbox: Sandbox,
  files: Record<string, string>,
  log: PreviewLogCallback,
): Promise<void> {
  const writable = Object.entries(files).filter(
    ([path]) =>
      !BAKED_FILES.has(path) &&
      // LLM-controlled paths: block traversal/absolute escapes out of PROJECT_DIR.
      !path.includes("..") &&
      !path.startsWith("/"),
  );
  const skipped = Object.keys(files).length - writable.length;
  log(`Writing ${writable.length} files...${skipped ? ` (${skipped} baked config file(s) skipped)` : ""}`);
  try {
    await Promise.all(
      writable.map(([path, content]) =>
        sandbox.files.write(`${PROJECT_DIR}/${path}`, content),
      ),
    );
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to write files to sandbox");
    throw err;
  }
}

async function saveSandboxId(projectId: string, sandboxId: string, framework: FullstackFramework): Promise<void> {
  try {
    await redis.set(redisKey(projectId), sandboxId, "EX", SANDBOX_REDIS_TTL_SECONDS);
    await redis.set(frameworkRedisKey(projectId), framework, "EX", SANDBOX_REDIS_TTL_SECONDS);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to save sandboxId to Redis");
    throw err;
  }
}

async function loadFramework(projectId: string): Promise<FullstackFramework | null> {
  try {
    const f = await redis.get(frameworkRedisKey(projectId));
    return (f as FullstackFramework) ?? null;
  } catch {
    return null;
  }
}

async function loadSandboxId(projectId: string): Promise<string | null> {
  try {
    return await redis.get(redisKey(projectId));
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to read sandboxId from Redis");
    throw err;
  }
}

async function deleteSandboxId(projectId: string): Promise<void> {
  try {
    await redis.del(redisKey(projectId));
    await redis.del(frameworkRedisKey(projectId));
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to delete sandboxId from Redis");
    throw err;
  }
}

/**
 * Tries to resume a previously-paused sandbox by ID. The E2B SDK exposes
 * resumption through `Sandbox.connect()` — if the sandbox is paused it is
 * automatically resumed; there is no separate `resume()` API. Returns `null`
 * if the snapshot is gone (expired/evicted) so the caller can fall back to
 * creating a fresh sandbox.
 */
async function tryResumeSandbox(projectId: string, sandboxId: string): Promise<Sandbox | null> {
  try {
    const sandbox = await Sandbox.connect(sandboxId, {
      ...(config.E2B_API_KEY ? { apiKey: config.E2B_API_KEY } : {}),
      // CRITICAL: connect/resume defaults the sandbox lifetime to 5 minutes
      // (same SDK default as create) — without this every resumed sandbox
      // died 5 minutes later, killing the preview mid-session.
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    console.log("[E2B] Resumed sandbox:", sandboxId, "for project:", projectId);
    return sandbox;
  } catch (err) {
    logger.warn({ projectId, sandboxId, err }, "[e2b] Failed to resume sandbox — snapshot likely expired");
    await deleteSandboxId(projectId);
    return null;
  }
}

// NOTE: no runtime `npm install` anywhere in this service — deps are baked
// into the template (skill rule: template owns package.json/node_modules).
// Runtime installs were a root cause of dev-server crashes mid-session.

/**
 * Wraps a PreviewLogCallback so each line is also captured in a rolling
 * in-memory buffer (last `maxLines` lines). Used to collect dev-server output
 * for diagnostics when waitForServerReady times out.
 */
function makeDevLog(
  log: PreviewLogCallback,
  maxLines = 80,
): { log: PreviewLogCallback; last: () => string[] } {
  const buf: string[] = [];
  return {
    log: (line: string) => {
      log(line);
      buf.push(line);
      if (buf.length > maxLines) buf.shift();
    },
    last: () => buf.slice(),
  };
}

/**
 * Runs a quick liveness probe (pgrep) and returns a diagnostic string
 * containing process status + the buffered last lines of dev-server output.
 * Never throws — if the probe itself fails we still return a useful partial
 * message so the original timeout error is enriched, not lost.
 */
async function fetchDevServerDiag(
  sandbox: Sandbox,
  framework: FullstackFramework,
  lastLines: string[],
): Promise<string> {
  let processStatus = "UNKNOWN";
  try {
    const killPat = devKillPattern(framework);
    const probe = await sandbox.commands.run(`pgrep -f '${killPat}' && echo ALIVE || echo DEAD`, {
      timeoutMs: 10_000,
    });
    processStatus = probe.stdout.trim().includes("ALIVE") ? "ALIVE" : "DEAD";
  } catch {
    // probe command failed (sandbox may already be dead) — leave as UNKNOWN
  }
  const output = lastLines.join("\n").trim();
  return `Process: ${processStatus}. Last output:\n${output || "(no output captured)"}`;
}

async function startDevServer(
  sandbox: Sandbox,
  log: PreviewLogCallback,
  framework: FullstackFramework,
): Promise<void> {
  const cmd = devStartCommand(framework);
  try {
    log(`Starting dev server (${framework})...`);
    await sandbox.commands.run(cmd, {
      cwd: PROJECT_DIR,
      background: true,
      // CRITICAL: the SDK's default command timeout is 60s and it applies to
      // background commands too — without this, E2B killed the dev server one
      // minute after boot ("no service running on port …").
      // 0 = no timeout; the dev server lives as long as the sandbox.
      timeoutMs: 0,
      onStdout: log,
      onStderr: log,
    });
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to start dev server");
    throw err;
  }
}

function previewUrlFor(sandbox: Sandbox, framework: FullstackFramework): string {
  // Use the SDK's getHost() — it returns the correct public preview host for
  // this E2B deployment (domain + region). A hardcoded "port-{id}.e2b.dev"
  // string is fragile and was the cause of preview URLs that never resolved.
  return `https://${sandbox.getHost(devPort(framework))}`;
}

/**
 * Self-healing guard: makes sure Vite is actually listening before we hand the
 * preview URL to the client. Covers every "the sandbox exists" path — resumed
 * snapshots whose dev server died, processes killed by timeouts/OOM, etc.
 * Quick single probe when healthy (~one HTTP round-trip).
 */
async function ensureDevServer(
  sandbox: Sandbox,
  log: PreviewLogCallback,
  framework: FullstackFramework,
): Promise<void> {
  const url = previewUrlFor(sandbox, framework);
  let serverUp = false;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000) });
    serverUp = res.ok || res.status < 500;
  } catch {
    // not listening — restart below
  }
  if (!serverUp) {
    log(`Dev server not responding — (re)starting ${framework} dev server...`);
    // Kill any half-dead process first so the restart won't lose a port conflict.
    const killPat = devKillPattern(framework);
    await sandbox.commands.run(`pkill -f ${killPat} || true`, { timeoutMs: 10_000 }).catch(() => {});
    const devLog = makeDevLog(log);
    await startDevServer(sandbox, devLog.log, framework);
    const ready = await waitForServerReady(url, framework);
    if (!ready) {
      const diag = await fetchDevServerDiag(sandbox, framework, devLog.last());
      throw new Error(`Dev server did not respond at ${url} within ${readyPollTimeoutMs(framework) / 1000}s. ${diag}`);
    }
    log("Dev server is up");
  }
  // Also (re)start the app's own Hono/Node backend if it ships one — no-op for
  // Next.js/TanStack (Route Handlers / createServerFn are served by the framework).
  if (framework === "react") {
    await ensureBackendServer(sandbox, log).catch(() => {});
  }
}

/**
 * Starts the app's REAL backend inside the sandbox when it ships one
 * (src/server/index.ts). The backend (Hono/Node) listens on :3001 and Vite
 * proxies /api/* to it, so generated apps can serve real API routes
 * (/api/riders, /api/orders, Stripe webhooks, …) — not just Supabase-direct
 * calls. Always (re)started after a write so it runs the latest code; no-op for
 * frontend-only / Supabase-direct apps. Runs under tsx (baked in the template).
 */
async function ensureBackendServer(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  // Detect the backend's runtime by its entry file: Node/Hono (src/server/index.ts)
  // or Python/FastAPI (src/server/main.py). Either runs on :3001.
  let runtime: "node" | "python" | null = null;
  let envText = "";
  try {
    const r = await sandbox.commands.run(
      "test -f src/server/index.ts && echo NODE; test -f src/server/main.py && echo PY; cat .env 2>/dev/null || true",
      { cwd: PROJECT_DIR, timeoutMs: 10_000 },
    );
    if (r.stdout.includes("PY")) runtime = "python";
    else if (r.stdout.includes("NODE")) runtime = "node";
    envText = r.stdout;
  } catch {
    return;
  }
  if (!runtime) return;

  // Parse .env (KEY=VALUE lines) so we can pass Supabase creds to BOTH runtimes
  // uniformly via the process env (Python's uvicorn doesn't read --env-file).
  const envs: Record<string, string> = { PORT: "3001" };
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] && m[2] !== undefined) envs[m[1]] = m[2];
  }

  await sandbox.commands.run("pkill -f 'src/server/index' || true; pkill -f uvicorn || true", { timeoutMs: 10_000 }).catch(() => {});
  log(`Starting ${runtime} backend server on :3001...`);
  const buf: string[] = [];
  backendLogs.set(sandbox.sandboxId, buf);
  const capture = (line: string): void => {
    log(line);
    buf.push(line);
    if (buf.length > 80) buf.shift();
  };

  // Node: tsx runs the Hono server. Python: uvicorn serves the FastAPI `app`
  // from src/server/main.py (run from that dir so `main:app` resolves).
  const cmd =
    runtime === "python"
      ? "cd src/server && python3 -m uvicorn main:app --host 0.0.0.0 --port 3001"
      : "tsx src/server/index.ts";
  try {
    await sandbox.commands.run(cmd, {
      cwd: PROJECT_DIR,
      background: true,
      timeoutMs: 0, // lives as long as the sandbox (default 60s would kill it)
      envs,
      onStdout: capture,
      onStderr: capture,
    });
  } catch (err) {
    logger.warn({ err }, "[e2b] Failed to start backend server");
  }
}

// Recent backend stdout/stderr per sandbox, for the agentic verify-and-fix step.
const backendLogs = new Map<string, string[]>();

function extractBackendError(lines: string[]): string {
  const text = lines.join("\n");
  // Pull the most informative error lines (stack header + message).
  const errLines = lines.filter((l) => /error|exception|cannot|undefined|not a function|ENOENT|throw|SyntaxError|TypeError|ReferenceError/i.test(l));
  return (errLines.slice(-12).join("\n") || text.slice(-1200)).trim();
}

export interface PreviewIssue {
  source: string;
  message: string;
}

/**
 * Agentic verification: after the app is written and the servers (re)started,
 * checks whether the REAL backend actually came up. If the Hono server crashed
 * on startup (bad import, runtime error, etc.) the preview's /api calls would
 * silently fail — instead we capture its error so the build flow can re-prompt
 * the model to fix src/server and try again. No-op for frontend-only apps.
 */
export async function verifyPreview(projectId: string): Promise<{ ok: boolean; issues: PreviewIssue[] }> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return { ok: true, issues: [] };

  let hasBackend = false;
  try {
    const r = await sandbox.commands.run(
      "test -f src/server/index.ts -o -f src/server/main.py && echo y",
      { cwd: PROJECT_DIR, timeoutMs: 10_000 },
    );
    hasBackend = r.stdout.includes("y");
  } catch {
    return { ok: true, issues: [] };
  }
  if (!hasBackend) return { ok: true, issues: [] };

  // Give the backend a moment, then check it's listening. Any HTTP status
  // (even 404) means it's up; a refused connection means it crashed.
  await new Promise((r) => setTimeout(r, 2_500));
  let up = false;
  try {
    const probe = await sandbox.commands.run(
      "curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3001/ || echo DOWN",
      { timeoutMs: 12_000 },
    );
    const code = probe.stdout.trim();
    up = code !== "" && code !== "DOWN" && code !== "000";
  } catch {
    up = false;
  }

  if (up) return { ok: true, issues: [] };
  const message = extractBackendError(backendLogs.get(sandbox.sandboxId) ?? []) || "backend did not start on port 3001";
  return { ok: false, issues: [{ source: "src/server/index.ts", message }] };
}

/** Whether a live, in-process sandbox is currently held for this project. */
export function hasSandbox(projectId: string): boolean {
  return sandboxes.has(projectId);
}

/**
 * Whether this project has ANY sandbox record (live in-process OR a paused
 * snapshot saved in Redis). Used to route follow-up edits of a fullstack
 * project back to the E2B preview instead of falling through to Sandpack.
 */
export async function hasSandboxRecord(projectId: string): Promise<boolean> {
  if (sandboxes.has(projectId)) return true;
  try {
    return (await loadSandboxId(projectId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Resumes (or, failing that, creates) a running sandbox for the project and
 * makes sure its Vite dev server is up — WITHOUT writing any app files. The
 * template already ships a baked baseline scaffold, so a fresh sandbox serves a
 * "Loading…" page immediately; the real files are streamed in later via HMR.
 * Registers the sandbox in the in-process map and Redis.
 */
async function acquireRunningSandbox(
  projectId: string,
  log: PreviewLogCallback,
  framework: FullstackFramework = "react",
): Promise<Sandbox> {
  const savedSandboxId = await loadSandboxId(projectId);
  if (savedSandboxId) {
    const resumed = await tryResumeSandbox(projectId, savedSandboxId);
    if (resumed) {
      sandboxes.set(projectId, resumed);
      sandboxFrameworks.set(projectId, framework);
      // A resumed snapshot's dev server may not have survived the pause —
      // verify and restart it if needed rather than assuming.
      await ensureDevServer(resumed, log, framework);
      log("Resumed existing sandbox");
      return resumed;
    }
  }

  log("Creating fresh sandbox from template...");
  const sandbox = await Sandbox.create(selectTemplate(framework), {
    ...(config.E2B_API_KEY ? { apiKey: config.E2B_API_KEY } : {}),
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  console.log("[E2B] Sandbox created (prewarm):", sandbox.sandboxId);
  sandboxes.set(projectId, sandbox);
  sandboxFrameworks.set(projectId, framework);
  await saveSandboxId(projectId, sandbox.sandboxId, framework);

  try {
    // Inject preview env BEFORE the dev server boots (env is only read at startup).
    await writePreviewEnv(sandbox, projectId, log);
    // Baked scaffold already has node_modules — this is just dev-server startup.
    const devLog = makeDevLog(log);
    await startDevServer(sandbox, devLog.log, framework);
    const ready = await waitForServerReady(previewUrlFor(sandbox, framework), framework);
    if (!ready) {
      const diag = await fetchDevServerDiag(sandbox, framework, devLog.last());
      throw new Error(`Prewarmed sandbox dev server did not become ready within ${readyPollTimeoutMs(framework) / 1000}s. ${diag}`);
    }
    return sandbox;
  } catch (err) {
    // Don't leave a dead sandbox registered as "live" — the completion path
    // would reuse it and hand the client a broken preview URL. Clean up fully
    // so it does a fresh cold start instead.
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    await deleteSandboxId(projectId).catch(() => {});
    await sandbox.kill().catch(() => {});
    throw err;
  }
}

/**
 * Kicks off sandbox boot in the BACKGROUND at build start so it warms up in
 * parallel with AI code generation (the "ensure sandbox first" pattern). By the
 * time files are ready, Vite is already running and we only stream the files in.
 * Idempotent: a no-op if the sandbox is already live or already warming.
 */
export function prewarmSandbox(projectId: string, framework: FullstackFramework = "react", onLog?: PreviewLogCallback): void {
  if (!config.E2B_API_KEY) return;
  if (sandboxes.has(projectId) || warmingSandboxes.has(projectId)) return;

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b:prewarm]");
  };

  const promise = acquireRunningSandbox(projectId, log, framework)
    .catch((err) => {
      // Don't let a prewarm failure kill anything — the complete path will
      // fall back to a full create. Just surface it and clear the entry.
      logger.warn({ projectId, err }, "[e2b] prewarm failed (will cold-start on complete)");
      throw err;
    })
    .finally(() => {
      warmingSandboxes.delete(projectId);
    });

  warmingSandboxes.set(projectId, promise);
  void promise.catch(() => {});
}

/** Awaits an in-flight prewarm (if any) so we never race into a 2nd sandbox. */
async function awaitWarming(projectId: string): Promise<void> {
  const warming = warmingSandboxes.get(projectId);
  if (warming) {
    try {
      await warming;
    } catch {
      // prewarm failed — fall through; caller's own create path handles it.
    }
  }
}

/**
 * Pushes new files straight into a project's already-running sandbox and
 * returns its preview URL — no install, no dev-server (re)start, no
 * readiness poll. Used for follow-up builds: Vite's HMR picks up the file
 * changes and refreshes the preview automatically.
 *
 * Throws if no live sandbox is held for the project — callers should guard
 * with `hasSandbox(projectId)` first.
 */
export async function writeFilesToSandbox(
  projectId: string,
  files: Record<string, string>,
  onLog?: PreviewLogCallback,
): Promise<string> {
  await awaitWarming(projectId);
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) {
    throw new Error(`No live E2B sandbox for project ${projectId}`);
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b]");
  };

  const framework = sandboxFrameworks.get(projectId) ?? "react";
  patchViteConfig(files, log);
  // Heartbeat: every follow-up write extends the sandbox lifetime so an
  // actively-used session never hits the timeout set at create/resume.
  await sandbox.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
  await writeFiles(sandbox, files, log);
  await ensureDevServer(sandbox, log, framework);
  const url = previewUrlFor(sandbox, framework);
  log(`Preview updated at ${url} (HMR will refresh automatically)`);
  return url;
}

/**
 * Resume-on-open: when a user re-opens a project (no new build), bring its
 * preview back to life and return a FRESH URL. Resume-only — it never creates a
 * brand-new sandbox, because a fresh sandbox wouldn't contain the user's
 * generated files (those live in the paused snapshot). Returns null when there
 * is nothing to resume (no prior build, or the snapshot expired) so the caller
 * simply leaves the preview as-is until the next build.
 */
export async function ensurePreviewForProject(
  projectId: string,
  onLog?: PreviewLogCallback,
): Promise<string | null> {
  if (!config.E2B_API_KEY) return null;

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b:resume-on-open]");
  };

  await awaitWarming(projectId);

  // Already live in this process — just make sure the dev server is up.
  const live = sandboxes.get(projectId);
  if (live) {
    const framework = sandboxFrameworks.get(projectId) ?? "react";
    try {
      await ensureDevServer(live, log, framework);
      await live.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
      return previewUrlFor(live, framework);
    } catch {
      // live ref is dead — drop it and try to resume the snapshot below.
      sandboxes.delete(projectId);
      sandboxFrameworks.delete(projectId);
    }
  }

  const savedId = await loadSandboxId(projectId);
  if (!savedId) return null; // never built / snapshot gone — nothing to resume.

  // Load the framework from Redis so the correct port (3000 vs 5173) is used
  // after a server restart when the in-memory sandboxFrameworks map is empty.
  const persistedFramework = await loadFramework(projectId);

  let warm = warmingSandboxes.get(projectId);
  if (!warm) {
    warm = (async () => {
      const resumed = await tryResumeSandbox(projectId, savedId);
      if (!resumed) throw new Error("resume-on-open: snapshot unavailable");
      sandboxes.set(projectId, resumed);
      const framework = sandboxFrameworks.get(projectId) ?? persistedFramework ?? "react";
      sandboxFrameworks.set(projectId, framework);
      await ensureDevServer(resumed, log, framework);
      return resumed;
    })().finally(() => warmingSandboxes.delete(projectId));
    warmingSandboxes.set(projectId, warm);
  }

  try {
    const sb = await warm;
    await sb.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
    const framework = sandboxFrameworks.get(projectId) ?? "react";
    return previewUrlFor(sb, framework);
  } catch (err) {
    logger.warn({ projectId, err }, "[e2b] resume-on-open failed — preview needs a rebuild");
    return null;
  }
}

/**
 * Returns the live preview URL for a project's sandbox, creating, resuming,
 * or reusing one as needed (the "Lovable" get-or-create pattern):
 *
 *   1. Already running in this process?  → write files, verify Vite, return URL.
 *   2. A prewarm/acquire in flight?       → await the SAME promise (no 2nd sandbox).
 *   3. Otherwise → acquireRunningSandbox: resume the paused snapshot or create
 *      fresh from TEMPLATE_ID, inject preview env, start Vite, wait until ready.
 *
 * Every turn refreshes the sandbox lifetime (setTimeout heartbeat).
 * Never kills an existing sandbox — reuse, not replace.
 */
export async function createPreviewSandbox(
  sessionId: string,
  projectId: string,
  framework: FullstackFramework,
  files: Record<string, string>,
  onLog?: PreviewLogCallback,
): Promise<string> {
  console.log("[E2B] Starting sandbox creation for session:", sessionId, "project:", projectId);
  console.log("[E2B] API key present:", !!config.E2B_API_KEY);
  console.log("[E2B] File count:", Object.keys(files).length);

  if (!config.E2B_API_KEY) {
    console.error("[E2B] E2B_API_KEY is not configured — cannot start preview sandbox");
    throw new Error("E2B_API_KEY is not configured on the server");
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ sessionId, projectId, line }, "[e2b]");
  };

  patchViteConfig(files, log);

  let sandbox: Sandbox | undefined;
  try {
    // ── Acquire (race-proof): live → in-flight warm → resume-or-create ──────
    // All acquisition funnels through the warmingSandboxes promise-cache, so
    // concurrent callers (prewarm vs completion, double builds) always share
    // ONE sandbox instead of leaking a second one.
    await awaitWarming(projectId);
    sandbox = sandboxes.get(projectId);
    if (sandbox) {
      console.log("[E2B] Reusing live in-process sandbox for project:", projectId);
    } else {
      let warm = warmingSandboxes.get(projectId);
      if (!warm) {
        warm = acquireRunningSandbox(projectId, log, framework).finally(() => {
          warmingSandboxes.delete(projectId);
        });
        warmingSandboxes.set(projectId, warm);
      }
      sandbox = await warm;
    }

    // Each build turn extends the sandbox lifetime — a long iterate session
    // must not die at the timeout set when the sandbox was first created.
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});

    await writeFiles(sandbox, files, log);
    await ensureDevServer(sandbox, log, framework);

    const url = previewUrlFor(sandbox, framework);
    console.log("[E2B] Dev server is ready:", url);
    log(`Preview ready at ${url}`);
    return url;
  } catch (err) {
    console.error("[E2B] FULL ERROR:", err);
    console.error("[E2B] Error name:", err instanceof Error ? err.name : typeof err);
    console.error("[E2B] Error message:", err instanceof Error ? err.message : String(err));
    console.error("[E2B] Error stack:", err instanceof Error ? err.stack : undefined);
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    await sandbox?.kill().catch(() => {});
    throw err;
  }
}

/**
 * Pauses a project's sandbox: snapshots its state on E2B's side and drops the
 * in-process reference, but keeps the Redis record (the saved sandboxId is
 * exactly what `createPreviewSandbox` needs to resume it later). No-op if no
 * live sandbox is held in this process.
 */
export async function pauseSandbox(projectId: string): Promise<void> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return;

  try {
    await sandbox.pause();
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    console.log("[E2B] Paused sandbox for project:", projectId);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to pause sandbox");
    throw err;
  }
}

/**
 * Tears down the sandbox for a project entirely — removes both the in-process
 * reference and the Redis record (unlike pause, there is nothing to resume
 * afterwards). Use only on project delete or explicit user cancel; never on
 * follow-up builds — those should reuse the existing sandbox.
 */
export async function killSandbox(projectId: string): Promise<void> {
  try {
    const existing = sandboxes.get(projectId);
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    if (existing) {
      await existing.kill().catch((err) => {
        logger.warn({ projectId, err }, "Failed to kill E2B sandbox");
      });
    }
    await deleteSandboxId(projectId);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to kill sandbox");
    throw err;
  }
}

/**
 * Tears down every active in-process sandbox. Used on process shutdown
 * (SIGTERM) so we don't leak running E2B VMs when the server restarts/
 * redeploys — without this, sandboxes only die via their own 30-minute idle
 * timeout on E2B's side.
 */
export async function killAllSandboxes(): Promise<void> {
  const projectIds = [...sandboxes.keys()];
  if (projectIds.length === 0) return;
  logger.info({ count: projectIds.length }, "Killing all active E2B sandboxes");
  await Promise.all(projectIds.map((projectId) => killSandbox(projectId)));
}
