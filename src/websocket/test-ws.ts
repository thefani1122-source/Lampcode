/**
 * WebSocket integration smoke test.
 *
 * Creates a bare HTTP server in-process, attaches WebSocketServer to it,
 * connects socket.io-client to each namespace, and verifies event delivery.
 *
 * Usage:
 *   npx tsx src/websocket/test-ws.ts
 *
 * Note: config.ts validates env vars at import time, so any env required by
 * imported modules must be present. The test itself does not touch the DB.
 */

import { createServer, type Server as HttpServer } from "http";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { WebSocketServer } from "./server.js";
import { type ServerType } from "@hono/node-server";
import { type BuildServerEvents, type ProjectServerEvents, type UserServerEvents } from "./types.js";

// ── Minimal JWT (no real signing — decoder only checks structure + expiry) ────

function makeTestJwt(userId: string, email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-sig`;
}

// ── Tiny test harness ─────────────────────────────────────────────────────────

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(55)} ... `);
    try {
      await fn();
      console.log("OK");
      passed++;
    } catch (err) {
      console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
}

function waitFor<T>(socket: ClientSocket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function whenConnected(socket: ClientSocket, timeoutMs = 3_000): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connect timeout")), timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nBuildForge WebSocket — smoke test\n");

  const PORT = 54321;
  const httpServer: HttpServer = createServer();
  // ServerType from @hono/node-server is http.Server | Http2Server | Http2SecureServer.
  // createServer() returns http.Server which satisfies that union.
  const wsServer = new WebSocketServer(httpServer as unknown as ServerType);

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));

  const TOKEN = makeTestJwt("user-123", "test@example.com");
  const SESSION_ID = "00000000-0000-0000-0000-000000000001";
  const PROJECT_ID = "proj-abc";
  const USER_ID = "user-123";

  const mkClient = (namespace: string, token?: string): ClientSocket =>
    ioClient(`http://localhost:${PORT}/${namespace}`, {
      auth: { token: token ?? TOKEN },
      transports: ["websocket"],
    });

  // ── Tests ────────────────────────────────────────────────────────────────────

  test("Build namespace: connect with valid JWT", async () => {
    const c = mkClient("build");
    await whenConnected(c);
    c.disconnect();
  });

  test("Build namespace: reject connection without token", async () => {
    const c = ioClient(`http://localhost:${PORT}/build`, { transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Expected connect_error")), 3_000);
      c.once("connect_error", () => { clearTimeout(timer); c.disconnect(); resolve(); });
      c.once("connect", () => {
        clearTimeout(timer);
        c.disconnect();
        reject(new Error("Connection should have been rejected"));
      });
    });
  });

  test("Build namespace: join_session ack returns true", async () => {
    const c = mkClient("build");
    await whenConnected(c);
    const ack: boolean = await new Promise((resolve) =>
      c.emit("join_session", SESSION_ID, resolve),
    );
    if (!ack) throw new Error("join_session ack was false");
    c.disconnect();
  });

  test("Build namespace: receive agent_start after server emit", async () => {
    const c = mkClient("build");
    await whenConnected(c);
    await new Promise<void>((resolve) => c.emit("join_session", SESSION_ID, () => resolve()));

    const waiter = waitFor<Parameters<BuildServerEvents["agent_start"]>[0]>(c, "agent_start");
    wsServer.agentStart(SESSION_ID, {
      taskId: "task-1",
      sessionId: SESSION_ID,
      agentType: "backend",
      taskName: "Build API",
      model: "anthropic/claude-sonnet-4-5",
      tier: 1,
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.taskId !== "task-1") throw new Error(`Expected taskId "task-1", got "${event.taskId}"`);
    c.disconnect();
  });

  test("Build namespace: receive phase_complete after server emit", async () => {
    const c = mkClient("build");
    await whenConnected(c);
    await new Promise<void>((resolve) => c.emit("join_session", SESSION_ID, () => resolve()));

    const waiter = waitFor<Parameters<BuildServerEvents["phase_complete"]>[0]>(c, "phase_complete");
    wsServer.phaseComplete(SESSION_ID, {
      sessionId: SESSION_ID,
      phase: "BUILD",
      nextPhase: "VERIFY",
      creditsUsed: 22,
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.phase !== "BUILD") throw new Error(`Expected phase "BUILD", got "${event.phase}"`);
    c.disconnect();
  });

  test("Build namespace: receive build_failed after server emit", async () => {
    const c = mkClient("build");
    await whenConnected(c);
    await new Promise<void>((resolve) => c.emit("join_session", SESSION_ID, () => resolve()));

    const waiter = waitFor<Parameters<BuildServerEvents["build_failed"]>[0]>(c, "build_failed");
    wsServer.buildFailed(SESSION_ID, {
      sessionId: SESSION_ID,
      phase: "VERIFY",
      reason: "Security check failed",
      logs: "CRITICAL: SQL injection found",
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.reason !== "Security check failed") throw new Error("Wrong reason");
    c.disconnect();
  });

  test("Project namespace: join_project and receive settings_changed", async () => {
    const c = mkClient("project");
    await whenConnected(c);
    await new Promise<void>((resolve) => c.emit("join_project", PROJECT_ID, () => resolve()));

    const waiter = waitFor<Parameters<ProjectServerEvents["settings_changed"]>[0]>(c, "settings_changed");
    wsServer.settingsChanged(PROJECT_ID, {
      projectId: PROJECT_ID,
      changedBy: USER_ID,
      fields: ["buildCommand", "outputDir"],
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.projectId !== PROJECT_ID) throw new Error("Wrong projectId");
    c.disconnect();
  });

  test("User namespace: auto-subscribed and receives notification", async () => {
    const c = mkClient("user");
    await whenConnected(c);

    const waiter = waitFor<Parameters<UserServerEvents["notification"]>[0]>(c, "notification");
    wsServer.notify(USER_ID, {
      id: "notif-1",
      userId: USER_ID,
      title: "Build complete",
      message: "Your project compiled successfully.",
      level: "info",
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.id !== "notif-1") throw new Error("Wrong notification id");
    c.disconnect();
  });

  test("User namespace: receives credit_low event", async () => {
    const c = mkClient("user");
    await whenConnected(c);

    const waiter = waitFor<Parameters<UserServerEvents["credit_low"]>[0]>(c, "credit_low");
    wsServer.creditLow(USER_ID, {
      userId: USER_ID,
      remaining: 45,
      limit: 1000,
      percentUsed: 95.5,
      timestamp: new Date().toISOString(),
    });
    const event = await waiter;
    if (event.remaining !== 45) throw new Error("Wrong remaining credits");
    c.disconnect();
  });

  test("Rate limiter: reject 6th connection from same user", async () => {
    const clients: ClientSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const c = mkClient("build");
      await whenConnected(c);
      clients.push(c);
    }
    const sixth = mkClient("build");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Expected connect_error for 6th connection")),
        3_000,
      );
      sixth.once("connect_error", () => { clearTimeout(timer); resolve(); });
      sixth.once("connect", () => {
        clearTimeout(timer);
        reject(new Error("6th connection should have been rejected"));
      });
    });
    for (const c of clients) c.disconnect();
    sixth.disconnect();
  });

  // ── Run ────────────────────────────────────────────────────────────────────

  await runTests();

  await wsServer.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
