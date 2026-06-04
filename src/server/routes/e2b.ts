import { Hono } from "hono";
import { Sandbox } from "e2b";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

const SANDBOX_TEMPLATE = "base"; // Ubuntu with Node.js 20 pre-installed
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard limit from E2B
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min inactivity → auto-kill
const DEV_PORT = 5173; // Vite default
const SANDBOX_ROOT = "/home/user/app";

// ── Sandbox registry ──────────────────────────────────────────────────────────

interface SandboxEntry {
  sandbox: Sandbox;
  userId: string;
  projectId: string;
  sessionId: string;
  previewUrl: string;
  createdAt: number;
  lastUsedAt: number;
  inactivityTimer: ReturnType<typeof setTimeout>;
}

// Keyed by E2B sandboxId
const registry = new Map<string, SandboxEntry>();

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

function resetInactivityTimer(sandboxId: string): void {
  const entry = registry.get(sandboxId);
  if (!entry) return;
  clearTimeout(entry.inactivityTimer);
  entry.lastUsedAt = Date.now();
  entry.inactivityTimer = scheduleInactivityKill(sandboxId);
}

function scheduleInactivityKill(sandboxId: string): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    const entry = registry.get(sandboxId);
    if (!entry) return;
    const idleSec = Math.round((Date.now() - entry.lastUsedAt) / 1000);
    registry.delete(sandboxId);
    const apiKey = process.env["E2B_API_KEY"];
    try {
      if (apiKey) await Sandbox.kill(sandboxId, { apiKey });
      else await Sandbox.kill(sandboxId);
      logger.info({ sandboxId, idleSec }, `Sandbox ${sandboxId} destroyed after ${idleSec}s inactivity`);
    } catch (err) {
      logger.warn({ sandboxId, err }, "E2B kill on inactivity failed (sandbox may have already expired)");
    }
  }, INACTIVITY_TIMEOUT_MS);
}

// ── Vite scaffolding ──────────────────────────────────────────────────────────
// The LLM generates files for Sandpack (no bundler). We add the minimal Vite
// wiring needed to make them runnable in a real Node environment.

function addViteScaffolding(files: Record<string, string>): Record<string, string> {
  const result = { ...files };

  // Patch package.json: add vite, @vitejs/plugin-react, and a dev script
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(result["package.json"] ?? "{}") as Record<string, unknown>; } catch { /* use empty */ }
  const deps = ((pkg["dependencies"] ?? {}) as Record<string, string>);
  const devDeps = ((pkg["devDependencies"] ?? {}) as Record<string, string>);
  pkg["scripts"] = { ...(pkg["scripts"] as object ?? {}), dev: `vite --port ${DEV_PORT} --host 0.0.0.0` };
  pkg["dependencies"] = {
    ...deps,
    react: deps["react"] ?? "^18.2.0",
    "react-dom": deps["react-dom"] ?? "^18.2.0",
  };
  pkg["devDependencies"] = {
    ...devDeps,
    vite: "^5.2.0",
    "@vitejs/plugin-react": "^4.2.1",
    "@types/react": devDeps["@types/react"] ?? "^18.2.0",
    "@types/react-dom": devDeps["@types/react-dom"] ?? "^18.2.0",
    typescript: devDeps["typescript"] ?? "^5.0.0",
  };
  result["package.json"] = JSON.stringify(pkg, null, 2);

  // vite.config.ts — use react plugin, proxy /api to port 3001 for fullstack builds
  if (!result["vite.config.ts"]) {
    const hasBackend = Object.keys(files).some(
      (p) => p.startsWith("src/server/") || p.startsWith("src/db/"),
    );
    result["vite.config.ts"] = [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      "",
      "export default defineConfig({",
      "  plugins: [react()],",
      `  server: { port: ${DEV_PORT}, host: '0.0.0.0'${hasBackend ? ", proxy: { '/api': 'http://localhost:3001' }" : ""} },`,
      "});",
    ].join("\n");
  }

  // index.html — Vite entry point
  if (!result["index.html"]) {
    result["index.html"] = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "    <title>App</title>",
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script type="module" src="/src/index.tsx"></script>',
      "  </body>",
      "</html>",
    ].join("\n");
  }

  return result;
}

// ── Background sandbox setup ──────────────────────────────────────────────────

async function setupSandbox(
  files: Record<string, string>,
  sessionId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  const apiKey = process.env["E2B_API_KEY"];
  const server = ws();

  const emit = (event: string, data: Record<string, unknown>) =>
    server?.emitToRoom(sessionId, event, data);

  let sandboxId = "(unknown)";
  try {
    emit("build:thinking", { text: "Creating E2B sandbox...", sessionId });

    const sb = apiKey
      ? await Sandbox.create(SANDBOX_TEMPLATE, { timeoutMs: SANDBOX_TIMEOUT_MS, apiKey })
      : await Sandbox.create(SANDBOX_TEMPLATE, { timeoutMs: SANDBOX_TIMEOUT_MS });
    sandboxId = sb.sandboxId;

    logger.info({ sandboxId, sessionId, projectId }, "E2B sandbox created");
    emit("build:thinking", { text: `Sandbox ready (${sandboxId}). Uploading files...`, sessionId });

    // ── Upload files ────────────────────────────────────────────────────────
    const scaffolded = addViteScaffolding(files);
    await Promise.all(
      Object.entries(scaffolded).map(([filePath, content]) =>
        sb.files.write(`${SANDBOX_ROOT}/${filePath}`, content),
      ),
    );
    logger.info({ sandboxId, fileCount: Object.keys(scaffolded).length }, "Files uploaded to sandbox");
    emit("build:thinking", {
      text: `${Object.keys(scaffolded).length} files uploaded. Running npm install...`,
      sessionId,
    });

    // ── npm install ─────────────────────────────────────────────────────────
    const installResult = await sb.commands.run("npm install", {
      cwd: SANDBOX_ROOT,
      timeoutMs: 120_000,
    });
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed (exit ${installResult.exitCode}): ${installResult.stderr.slice(0, 500)}`);
    }
    logger.info({ sandboxId }, "npm install complete");
    emit("build:thinking", { text: "Dependencies installed. Starting dev server...", sessionId });

    // ── Start Vite dev server in background ─────────────────────────────────
    await sb.commands.run("npm run dev", {
      cwd: SANDBOX_ROOT,
      background: true,
    });

    // Give Vite 8 seconds to bind the port
    await new Promise<void>((r) => setTimeout(r, 8_000));

    const previewUrl = `https://${sb.getHost(DEV_PORT)}`;
    const expiresAt = Date.now() + SANDBOX_TIMEOUT_MS;

    // ── Register for inactivity cleanup ─────────────────────────────────────
    const entry: SandboxEntry = {
      sandbox: sb,
      userId,
      projectId,
      sessionId,
      previewUrl,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inactivityTimer: scheduleInactivityKill(sandboxId),
    };
    registry.set(sandboxId, entry);

    console.log("[E2B] Sandbox created:", previewUrl);
    console.log("[E2B] Sandbox ID:", sandboxId);

    // ── Emit E2B ready event ─────────────────────────────────────────────────
    emit("build:e2b_ready", {
      sandboxId,
      sandboxUrl: previewUrl,
      expiresAt,
      sessionId,
    });
    logger.info({ sandboxId, previewUrl, expiresAt }, "E2B sandbox live");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] Sandbox creation failed:", msg);
    logger.error({ sandboxId, sessionId, err: msg }, "E2B sandbox setup failed");
    emit("build:e2b_error", {
      sandboxId,
      error: msg,
      sessionId,
    });
  }
}

// ── Request schemas ───────────────────────────────────────────────────────────

const createSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().uuid(),
  files: z.record(z.string(), z.string()),
});

const syncSchema = z.object({
  sandboxId: z.string().min(1),
  filePath: z.string().min(1),
  newContent: z.string(),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const e2bRouter = new Hono();
e2bRouter.use("/*", requireAuth);

// POST /api/e2b/create
// Starts sandbox setup in background; client listens for build:e2b_ready over WS.
e2bRouter.post("/create", async (c) => {
  const apiKey = process.env["E2B_API_KEY"];
  if (!apiKey) {
    console.error("[E2B] E2B_API_KEY is missing! Set it in Railway env vars.");
    return c.json({
      error: "E2B_API_KEY missing",
      message: "Please set E2B_API_KEY in Railway environment variables. Get it from e2b.dev/dashboard",
    }, 503);
  }

  const authUser = c.get("authUser");
  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  const { projectId, sessionId, files } = parsed.data;

  console.log("[E2B] Creating sandbox for project:", projectId);
  console.log("[E2B] Files count:", Object.keys(files).length);

  // Fire-and-forget: respond immediately, emit WS events as the sandbox boots
  setImmediate(() => {
    setupSandbox(files, sessionId, projectId, authUser.id).catch((err) =>
      logger.error({ err }, "Unhandled error in setupSandbox"),
    );
  });

  return c.json({
    status: "starting",
    message: "Sandbox is being prepared. Listen for build:e2b_ready over WebSocket.",
    sessionId,
  });
});

// POST /api/e2b/sync
// Write a single file into a running sandbox and let Vite HMR pick it up.
e2bRouter.post("/sync", async (c) => {
  const authUser = c.get("authUser");
  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });

  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  const { sandboxId, filePath, newContent } = parsed.data;

  const entry = registry.get(sandboxId);
  if (!entry) {
    throw new AppError(404, "Sandbox not found or has expired", "SANDBOX_NOT_FOUND");
  }
  if (entry.userId !== authUser.id) {
    throw new AppError(403, "You do not own this sandbox", "FORBIDDEN");
  }

  // Sanitise path: must be a relative path within the sandbox root
  const safePath = filePath.replace(/^[/\\]+/, "").replace(/\.\.\//g, "");
  await entry.sandbox.files.write(`${SANDBOX_ROOT}/${safePath}`, newContent);

  // Reset inactivity timer on every sync (user is actively editing)
  resetInactivityTimer(sandboxId);

  logger.info({ sandboxId, filePath: safePath }, "File synced to sandbox");
  return c.json({ ok: true, sandboxId, filePath: safePath });
});

// DELETE /api/e2b/:sandboxId
// Explicit teardown (e.g. when user closes the workspace tab).
e2bRouter.delete("/:sandboxId", async (c) => {
  const authUser = c.get("authUser");
  const { sandboxId } = c.req.param();

  const entry = registry.get(sandboxId);
  if (!entry) {
    // Already gone — return 204 so the client doesn't need to retry
    return c.body(null, 204);
  }
  if (entry.userId !== authUser.id) {
    throw new AppError(403, "You do not own this sandbox", "FORBIDDEN");
  }

  clearTimeout(entry.inactivityTimer);
  registry.delete(sandboxId);

  try {
    const apiKey = process.env["E2B_API_KEY"];
    if (apiKey) await Sandbox.kill(sandboxId, { apiKey });
    else await Sandbox.kill(sandboxId);
    logger.info({ sandboxId }, "Sandbox destroyed by user request");
  } catch (err) {
    logger.warn({ sandboxId, err }, "E2B kill on explicit delete failed");
  }

  return c.body(null, 204);
});
