import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { config, ALLOWED_ORIGINS } from "./config.js";
import { logger } from "./logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { projectsRouter } from "./routes/projects.js";
import { buildRouter } from "./routes/build.js";
import { planRouter } from "./routes/plan.js";
import { brainRouter } from "./routes/brain.js";
import { deployRouter } from "./routes/deploy.js";
import { integrationsRouter, providersRouter } from "./routes/integrations.js";
import { settingsRouter, userSettingsRouter } from "./routes/settings.js";
import { envRouter } from "./routes/env.js";
import { billingRouter } from "./routes/billing.js";
import { contextRouter } from "./routes/context.js";
import { interviewRouter } from "./routes/interview.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { createWebSocketServer, getWebSocketServer } from "../websocket/server.js";
import { startFastBuildWorker } from "../build/worker.js";
import { runFastBuild } from "./routes/build.js";

// ── Startup diagnostics ───────────────────────────────────────────────────────
// Log enough detail to diagnose connection issues without exposing credentials.
const _dbUrl = process.env["DATABASE_URL"];
const _dbEndpoint = (() => {
  try {
    const p = new URL(_dbUrl ?? "");
    return `${p.hostname}:${p.port || "5432"}`;
  } catch { return _dbUrl ? "SET (unparseable)" : "MISSING"; }
})();
console.log("ENV CHECK:", {
  DATABASE_URL: _dbEndpoint,
  SUPABASE_URL: process.env["SUPABASE_URL"] ? "SET" : "MISSING",
  SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"] ? "SET" : "MISSING",
  REDIS_URL: (process.env["REDIS_URL"] ?? process.env["REDIS_PUBLIC_URL"])
    ?.replace(/:\/\/[^@]+@/, "://***@") ?? "MISSING",
  FRONTEND_ORIGIN: process.env["FRONTEND_ORIGIN"] ?? process.env["FRONTEND_URL"] ?? "default",
});

const app = new Hono();

// CORS — allow all configured origins with credentials
app.use(
  "*",
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    credentials: true,
  }),
);

// Request logging
app.use("*", honoLogger((message, ...rest) => logger.info({ msg: message }, ...rest)));

// Rate limiting
app.use("*", rateLimitMiddleware);

// Health check (public)
app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// API routes
// authRouter handles custom routes (register/login/logout/me/refresh) and
// has a catch-all at the bottom that forwards everything else to auth.handler.
app.route("/api/auth", authRouter);
app.route("/api/users", usersRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/build", buildRouter);
app.route("/api/plan", planRouter);
app.route("/api/projects/:id/brain", brainRouter);
app.route("/api/projects/:id/integrations", integrationsRouter);
app.route("/api/projects/:id/settings", settingsRouter);
app.route("/api/projects/:id/env", envRouter);
app.route("/api/integrations", providersRouter);
app.route("/api/users/me/settings", userSettingsRouter);
app.route("/api/users/me/billing", billingRouter);
app.route("/api/deploy", deployRouter);
app.route("/api/context", contextRouter);
app.route("/api/interview", interviewRouter);
app.route("/api/webhooks", webhooksRouter);

// 404 handler
app.notFound((c) =>
  c.json(
    { error: { message: "Route not found", code: "NOT_FOUND" } },
    404,
  ),
);

// Global error handler
app.onError(errorHandler);

// Start server
const httpServer = serve(
  { fetch: app.fetch, port: config.PORT },
  (info) => logger.info({ port: info.port }, "Server listening"),
);

// Attach WebSocket server to the same HTTP server
createWebSocketServer(httpServer);

// Start BullMQ worker — non-blocking: a Redis failure here must not take down the HTTP server.
try {
  startFastBuildWorker(runFastBuild, getWebSocketServer());
} catch (err) {
  logger.warn({ err }, "Fast build worker could not start (Redis unavailable?) — will retry on redeploy");
}

export { app };
