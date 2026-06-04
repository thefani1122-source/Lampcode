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
      console.log(`[E2B] Sandbox ${sandboxId} destroyed after ${idleSec}s inactivity`);
      logger.info({ sandboxId, idleSec }, "E2B sandbox destroyed after inactivity");
    } catch (err) {
      logger.warn({ sandboxId, err }, "E2B kill on inactivity failed (sandbox may have already expired)");
    }
  }, INACTIVITY_TIMEOUT_MS);
}

// ── Vite scaffolding ──────────────────────────────────────────────────────────

function addViteScaffolding(files: Record<string, string>): Record<string, string> {
  const result = { ...files };

  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(result["package.json"] ?? "{}") as Record<string, unknown>; } catch { /* use empty */ }
  const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
  const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;
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

// ── Typed error codes ─────────────────────────────────────────────────────────

type E2BErrorCode =
  | "E2B_API_KEY_MISSING"
  | "SANDBOX_CREATION_FAILED"
  | "FILE_UPLOAD_FAILED"
  | "NPM_INSTALL_FAILED"
  | "SERVER_START_FAILED";

class E2BError extends Error {
  constructor(
    public readonly code: E2BErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "E2BError";
  }
}

// ── Sandbox setup (synchronous — caller awaits the full result) ───────────────

interface SetupResult {
  sandboxId: string;
  sandboxUrl: string;
  expiresAt: number;
}

async function setupSandbox(
  files: Record<string, string>,
  sessionId: string,
  projectId: string,
  userId: string,
  apiKey: string,
): Promise<SetupResult> {
  const server = ws();
  const emit = (event: string, data: Record<string, unknown>) =>
    server?.emitToRoom(sessionId, event, data);

  // ── 1. Create sandbox ───────────────────────────────────────────────────────
  emit("build:thinking", { text: "Creating E2B sandbox...", sessionId });
  let sb: Sandbox;
  try {
    sb = await Sandbox.create(SANDBOX_TEMPLATE, { timeoutMs: SANDBOX_TIMEOUT_MS, apiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] FAILED: Sandbox creation error:", msg);
    throw new E2BError("SANDBOX_CREATION_FAILED", msg);
  }

  const sandboxId = sb.sandboxId;
  console.log("[E2B] Sandbox instance created, ID:", sandboxId);
  emit("build:thinking", { text: `Sandbox ${sandboxId} ready. Uploading files...`, sessionId });

  // ── 2. Upload files ─────────────────────────────────────────────────────────
  const scaffolded = addViteScaffolding(files);
  try {
    await Promise.all(
      Object.entries(scaffolded).map(([filePath, content]) =>
        sb.files.write(`${SANDBOX_ROOT}/${filePath}`, content),
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] FAILED: File upload error:", msg);
    throw new E2BError("FILE_UPLOAD_FAILED", msg);
  }
  console.log("[E2B] Files uploaded:", Object.keys(scaffolded).length);
  emit("build:thinking", {
    text: `${Object.keys(scaffolded).length} files uploaded. Running npm install...`,
    sessionId,
  });

  // ── 3. npm install ──────────────────────────────────────────────────────────
  let installResult: Awaited<ReturnType<typeof sb.commands.run>>;
  try {
    installResult = await sb.commands.run("npm install", {
      cwd: SANDBOX_ROOT,
      timeoutMs: 120_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] FAILED: npm install threw:", msg);
    throw new E2BError("NPM_INSTALL_FAILED", `npm install threw: ${msg}`);
  }
  if (installResult.exitCode !== 0) {
    const detail = installResult.stderr.slice(0, 500) || installResult.stdout.slice(0, 500);
    console.error(`[E2B] FAILED: npm install exited ${installResult.exitCode}:`, detail);
    throw new E2BError("NPM_INSTALL_FAILED", `exit ${installResult.exitCode}: ${detail}`);
  }
  console.log("[E2B] npm install complete");
  emit("build:thinking", { text: "Dependencies installed. Starting dev server...", sessionId });

  // ── 4. Start Vite dev server ────────────────────────────────────────────────
  try {
    await sb.commands.run("npm run dev", {
      cwd: SANDBOX_ROOT,
      background: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] FAILED: npm run dev error:", msg);
    throw new E2BError("SERVER_START_FAILED", msg);
  }

  // Give Vite time to bind the port
  await new Promise<void>((r) => setTimeout(r, 8_000));

  const sandboxUrl = `https://${sb.getHost(DEV_PORT)}`;
  const expiresAt = Date.now() + SANDBOX_TIMEOUT_MS;

  // ── 5. Register for inactivity cleanup ──────────────────────────────────────
  registry.set(sandboxId, {
    sandbox: sb,
    userId,
    projectId,
    sessionId,
    previewUrl: sandboxUrl,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    inactivityTimer: scheduleInactivityKill(sandboxId),
  });

  console.log("[E2B] SUCCESS: Sandbox URL:", sandboxUrl);
  console.log("[E2B] SUCCESS: Sandbox ID:", sandboxId);
  emit("build:e2b_ready", { sandboxId, sandboxUrl, expiresAt, sessionId });
  logger.info({ sandboxId, sandboxUrl, expiresAt }, "E2B sandbox live");

  return { sandboxId, sandboxUrl, expiresAt };
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
// Synchronous: waits for full sandbox setup so the client gets real errors.
// Progress events are emitted over WebSocket during the wait (~30–60 s).
e2bRouter.post("/create", async (c) => {
  // ── API key check ────────────────────────────────────────────────────────
  const apiKey = process.env["E2B_API_KEY"];
  if (!apiKey) {
    console.error("[E2B] FAILED: E2B_API_KEY is missing! Set it in Railway env vars.");
    return c.json({
      error: "E2B_API_KEY_MISSING",
      message: "Set E2B_API_KEY in Railway environment variables. Get the key from e2b.dev/dashboard.",
    }, 503);
  }

  // ── Validate body ────────────────────────────────────────────────────────
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

  // ── Intake log ───────────────────────────────────────────────────────────
  console.log("[E2B] Received request for project:", projectId);
  console.log("[E2B] File count:", Object.keys(files).length);
  console.log("[E2B] E2B_API_KEY present:", true); // key existence already checked above

  // ── Run setup (synchronous) ──────────────────────────────────────────────
  try {
    const { sandboxId, sandboxUrl, expiresAt } = await setupSandbox(
      files, sessionId, projectId, authUser.id, apiKey,
    );
    return c.json({ sandboxId, sandboxUrl, expiresAt });
  } catch (err) {
    if (err instanceof E2BError) {
      console.error(`[E2B] FAILED (${err.code}):`, err.message);
      const status = err.code === "E2B_API_KEY_MISSING" ? 503 : 500;
      return c.json({ error: err.code, message: err.message }, status);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[E2B] FAILED (unexpected):", msg);
    return c.json({ error: "SANDBOX_CREATION_FAILED", message: msg }, 500);
  }
});

// POST /api/e2b/sync
// Write a single file into a running sandbox; Vite HMR picks it up.
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

  const safePath = filePath.replace(/^[/\\]+/, "").replace(/\.\.\//g, "");
  await entry.sandbox.files.write(`${SANDBOX_ROOT}/${safePath}`, newContent);
  resetInactivityTimer(sandboxId);

  console.log(`[E2B] File synced to sandbox ${sandboxId}: ${safePath}`);
  logger.info({ sandboxId, filePath: safePath }, "File synced to sandbox");
  return c.json({ ok: true, sandboxId, filePath: safePath });
});

// DELETE /api/e2b/:sandboxId
// Explicit teardown when the user closes the workspace tab.
e2bRouter.delete("/:sandboxId", async (c) => {
  const authUser = c.get("authUser");
  const { sandboxId } = c.req.param();

  const entry = registry.get(sandboxId);
  if (!entry) return c.body(null, 204);
  if (entry.userId !== authUser.id) {
    throw new AppError(403, "You do not own this sandbox", "FORBIDDEN");
  }

  clearTimeout(entry.inactivityTimer);
  registry.delete(sandboxId);

  try {
    const apiKey = process.env["E2B_API_KEY"];
    if (apiKey) await Sandbox.kill(sandboxId, { apiKey });
    else await Sandbox.kill(sandboxId);
    console.log("[E2B] Sandbox destroyed by user request:", sandboxId);
    logger.info({ sandboxId }, "Sandbox destroyed by user request");
  } catch (err) {
    logger.warn({ sandboxId, err }, "E2B kill on explicit delete failed");
  }

  return c.body(null, 204);
});
