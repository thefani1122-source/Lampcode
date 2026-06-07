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
const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const sandboxes = new Map<string, Sandbox>();

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
    for (const [path, content] of Object.entries(files)) {
      await sandbox.files.write(`${PROJECT_DIR}/${path}`, content);
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
    await sandbox.commands.run("npm run dev -- --host 0.0.0.0", {
      cwd: PROJECT_DIR,
      background: true,
      onStdout: log,
      onStderr: log,
    });

    const url = `https://${sandbox.getHost(DEV_SERVER_PORT)}`;
    console.log("[E2B] Preview URL:", url);
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
