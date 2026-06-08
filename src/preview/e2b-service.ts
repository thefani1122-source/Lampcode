import { Sandbox } from "e2b";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";

/**
 * E2B cloud sandbox preview for fullstack builds.
 *
 * Unlike the in-browser WebContainer/Sandpack preview (JS/TS only), E2B runs a
 * real Linux VM, so it can host backends in any language the LLM generates
 * (Node, Python, Go, etc). Sandboxes are kept alive per build session so the
 * user can keep interacting with the preview after the initial build.
 */

export type PreviewLogCallback = (line: string) => void;

const PROJECT_DIR = "/home/user/app";
const DEV_SERVER_PORT = 5173;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const READY_POLL_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 2_000;

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

/**
 * Spins up a fresh E2B sandbox, writes the build's files into it, installs
 * dependencies, and starts the dev server. Returns the public preview URL.
 *
 * Replaces any existing sandbox for the same session.
 */
export async function createPreviewSandbox(
  sessionId: string,
  files: Record<string, string>,
  onLog?: PreviewLogCallback,
): Promise<string> {
  console.log("[E2B] Starting sandbox creation for session:", sessionId);
  console.log("[E2B] API key present:", !!config.E2B_API_KEY);
  console.log("[E2B] File count:", Object.keys(files).length);

  if (!config.E2B_API_KEY) {
    console.error("[E2B] E2B_API_KEY is not configured — cannot start preview sandbox");
    throw new Error("E2B_API_KEY is not configured on the server");
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ sessionId, line }, "[e2b]");
  };

  await killSandbox(sessionId);

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create("base", {
      apiKey: config.E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    console.log("[E2B] Sandbox created:", sandbox.sandboxId);
    sandboxes.set(sessionId, sandbox);

    log(`Writing ${Object.keys(files).length} files...`);
    await Promise.all(
      Object.entries(files).map(([path, content]) =>
        sandbox!.files.write(`${PROJECT_DIR}/${path}`, content),
      ),
    );

    // Vite rejects requests from unrecognized hosts by default. E2B serves the
    // preview from a dynamically generated subdomain, so a React+Vite project's
    // generated vite.config.ts must explicitly allow it via allowedHosts.
    const viteConfig = files["vite.config.ts"];
    const isViteReact = Boolean(viteConfig?.includes("@vitejs/plugin-react"));
    if (isViteReact) {
      console.log("[E2B] Patching vite.config.ts to set allowedHosts for E2B preview domain");
      const vitePatch = `
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
})
`;
      await sandbox.files.write(`${PROJECT_DIR}/vite.config.ts`, vitePatch);
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

    log("Starting dev server...");
    // Run Vite directly (not via the package.json "dev" script) so it always
    // picks up our patched vite.config.ts allowedHosts override — npm run dev
    // would still launch the same vite binary, but going direct avoids any
    // chance of a generated script overriding host/port flags.
    const devCommand = isViteReact
      ? "npx vite --host 0.0.0.0 --port 5173"
      : "npm run dev -- --host 0.0.0.0";
    await sandbox.commands.run(devCommand, {
      cwd: PROJECT_DIR,
      background: true,
      onStdout: log,
      onStderr: log,
    });

    const url = `https://${sandbox.getHost(DEV_SERVER_PORT)}`;
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
    sandboxes.delete(sessionId);
    await sandbox?.kill().catch(() => {});
    throw err;
  }
}

/** Tears down the sandbox for a session, if one exists. Safe to call repeatedly. */
export async function killSandbox(sessionId: string): Promise<void> {
  const existing = sandboxes.get(sessionId);
  if (!existing) return;
  sandboxes.delete(sessionId);
  await existing.kill().catch((err) => {
    logger.warn({ sessionId, err }, "Failed to kill E2B sandbox");
  });
}

/**
 * Tears down every active sandbox. Used on process shutdown (SIGTERM) so we
 * don't leak running E2B VMs when the server restarts/redeploys — without this,
 * sandboxes only die via their own 30-minute idle timeout on E2B's side.
 */
export async function killAllSandboxes(): Promise<void> {
  const sessionIds = [...sandboxes.keys()];
  if (sessionIds.length === 0) return;
  logger.info({ count: sessionIds.length }, "Killing all active E2B sandboxes");
  await Promise.all(sessionIds.map((sessionId) => killSandbox(sessionId)));
}
