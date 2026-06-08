import { Sandbox } from "e2b";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { createRedis } from "../lib/redis.js";

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
const DEV_SERVER_PORT = 5173;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Custom template (see e2b.Dockerfile / e2b.toml) that pre-installs Node,
// frontend deps, and a baseline Vite/React scaffold. Falls back to the stock
// "base" template if no custom template has been built/configured yet.
const TEMPLATE_ID = process.env["E2B_TEMPLATE_ID"] ?? "base";

// E2B sandbox snapshots (created on pause) expire after 30 days. We key the
// Redis record's TTL slightly below that — 25 days — so we never hand back a
// sandboxId whose underlying snapshot has already been garbage-collected.
const SANDBOX_REDIS_TTL_SECONDS = 25 * 24 * 60 * 60;

const READY_POLL_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 2_000;

const redis = createRedis();

function redisKey(projectId: string): string {
  return `e2b:sandbox:${projectId}`;
}

// Live Sandbox object references for the current process lifetime — needed so
// follow-up builds in the same process can write files directly without a
// network round-trip to resume. Lost on restart; Redis is the durable record.
const sandboxes = new Map<string, Sandbox>();

/**
 * Polls the preview URL until it responds or the timeout elapses. The dev
 * server is started in the background with no readiness signal, so without
 * this we'd hand the user a URL that may still be 404ing/connection-refused.
 * Any HTTP response (even an error status) means the server is up and routing.
 */
async function waitForServerReady(url: string): Promise<boolean> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
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

async function writeFiles(
  sandbox: Sandbox,
  files: Record<string, string>,
  log: PreviewLogCallback,
): Promise<void> {
  log(`Writing ${Object.keys(files).length} files...`);
  try {
    await Promise.all(
      Object.entries(files).map(([path, content]) =>
        sandbox.files.write(`${PROJECT_DIR}/${path}`, content),
      ),
    );
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to write files to sandbox");
    throw err;
  }
}

async function saveSandboxId(projectId: string, sandboxId: string): Promise<void> {
  try {
    await redis.set(redisKey(projectId), sandboxId, "EX", SANDBOX_REDIS_TTL_SECONDS);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to save sandboxId to Redis");
    throw err;
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
    });
    console.log("[E2B] Resumed sandbox:", sandboxId, "for project:", projectId);
    return sandbox;
  } catch (err) {
    logger.warn({ projectId, sandboxId, err }, "[e2b] Failed to resume sandbox — snapshot likely expired");
    await deleteSandboxId(projectId);
    return null;
  }
}

async function installDependencies(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  try {
    // Skip the (slow) install step when the template already cached
    // node_modules for every dependency listed in package.json — a fresh
    // "base"-template sandbox will always need it; a prebuilt custom template
    // usually won't.
    log("Checking whether dependencies are already installed...");
    const check = await sandbox.commands.run(
      `node -e "
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const missing = deps.filter((d) => !fs.existsSync(path.join('node_modules', d)));
process.exit(missing.length === 0 ? 0 : 1);
"`,
      { cwd: PROJECT_DIR },
    );

    if (check.exitCode === 0) {
      log("Dependencies already installed — skipping npm install.");
      return;
    }

    log("Installing dependencies (npm install)...");
    const install = await sandbox.commands.run("npm install", {
      cwd: PROJECT_DIR,
      timeoutMs: 5 * 60 * 1000,
      onStdout: log,
      onStderr: log,
    });
    console.log("[E2B] Install exit code:", install.exitCode);
    if (install.exitCode !== 0) {
      console.error("[E2B] Install stderr:", install.stderr);
      throw new Error(`npm install exited with code ${install.exitCode}`);
    }
  } catch (err) {
    logger.error({ err }, "[e2b] Dependency install step failed");
    throw err;
  }
}

async function startDevServer(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  try {
    log("Starting dev server...");
    await sandbox.commands.run("npx vite --host 0.0.0.0 --port 5173", {
      cwd: PROJECT_DIR,
      background: true,
      onStdout: log,
      onStderr: log,
    });
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to start dev server");
    throw err;
  }
}

function previewUrlFor(sandbox: Sandbox): string {
  return `https://${sandbox.getHost(DEV_SERVER_PORT)}`;
}

/**
 * Returns the live preview URL for a project's sandbox, creating, resuming,
 * or reusing one as needed (the "Lovable" get-or-create pattern):
 *
 *   1. Already running in this process?  → just write files, return URL (HMR
 *      picks up the change — no install/start/poll needed).
 *   2. Previously paused (Redis has a saved sandboxId)? → try to resume it;
 *      on success, write files and return URL (Vite is already running).
 *   3. Otherwise (or resume failed)  → create a fresh sandbox from
 *      TEMPLATE_ID, save its ID, install deps if needed, start Vite, and
 *      poll until ready.
 *
 * Never kills an existing sandbox — reuse, not replace.
 */
export async function createPreviewSandbox(
  sessionId: string,
  projectId: string,
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

  // ── Case 1: already running in this process — reuse directly ──────────────
  const live = sandboxes.get(projectId);
  if (live) {
    console.log("[E2B] Reusing live in-process sandbox for project:", projectId);
    await writeFiles(live, files, log);
    const url = previewUrlFor(live);
    log(`Preview updated at ${url} (HMR will refresh automatically)`);
    return url;
  }

  let sandbox: Sandbox | undefined;
  try {
    // ── Case 2: previously paused — try to resume ────────────────────────────
    const savedSandboxId = await loadSandboxId(projectId);
    if (savedSandboxId) {
      const resumed = await tryResumeSandbox(projectId, savedSandboxId);
      if (resumed) {
        sandbox = resumed;
        sandboxes.set(projectId, sandbox);

        await writeFiles(sandbox, files, log);
        const url = previewUrlFor(sandbox);
        log(`Preview ready at ${url}`);
        return url;
      }
      // tryResumeSandbox already deleted the stale Redis key on failure.
    }

    // ── Case 3: nothing to resume — create a fresh sandbox ───────────────────
    sandbox = await Sandbox.create(TEMPLATE_ID, {
      apiKey: config.E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    console.log("[E2B] Sandbox created:", sandbox.sandboxId);
    sandboxes.set(projectId, sandbox);
    await saveSandboxId(projectId, sandbox.sandboxId);

    await writeFiles(sandbox, files, log);
    await installDependencies(sandbox, log);
    await startDevServer(sandbox, log);

    const url = previewUrlFor(sandbox);
    console.log("[E2B] Preview URL:", url);

    log("Waiting for dev server to become ready...");
    const ready = await waitForServerReady(url);
    if (!ready) {
      throw new Error(`Dev server did not respond at ${url} within ${READY_POLL_TIMEOUT_MS / 1000}s`);
    }

    console.log("[E2B] Dev server is ready:", url);
    log(`Preview ready at ${url}`);
    return url;
  } catch (err) {
    console.error("[E2B] FULL ERROR:", err);
    console.error("[E2B] Error name:", err instanceof Error ? err.name : typeof err);
    console.error("[E2B] Error message:", err instanceof Error ? err.message : String(err));
    console.error("[E2B] Error stack:", err instanceof Error ? err.stack : undefined);
    sandboxes.delete(projectId);
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
