import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { projectsRouter } from "./routes/projects.js";
import { buildRouter } from "./routes/build.js";
import { planRouter } from "./routes/plan.js";
import { brainRouter } from "./routes/brain.js";
import { integrationsRouter, deployRouter } from "./routes/deploy.js";
import { createWebSocketServer } from "../websocket/server.js";

const app = new Hono();

// CORS
app.use(
  "*",
  cors({
    origin: config.FRONTEND_ORIGIN,
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
app.route("/api/auth", authRouter);
app.route("/api/users", usersRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/build", buildRouter);
app.route("/api/plan", planRouter);
app.route("/api/projects/:id/brain", brainRouter);
app.route("/api/projects/:id/integrations", integrationsRouter);
app.route("/api/deploy", deployRouter);

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

export { app };
