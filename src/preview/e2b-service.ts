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
  if (!config.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is not configured");
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ sessionId, line }, "[e2b]");
  };

  await killSandbox(sessionId);

  const sandbox = await Sandbox.create("node", {
    apiKey: config.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  sandboxes.set(sessionId, sandbox);

  try {
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
    if (install.exitCode !== 0) {
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
    log(`Preview ready at ${url}`);
    return url;
  } catch (err) {
    sandboxes.delete(sessionId);
    await sandbox.kill().catch(() => {});
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
