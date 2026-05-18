/**
 * WebSocket event ordering test + manual client.
 *
 * Two modes:
 *   1. In-process unit test (no running server required) — verifies event
 *      ordering using a real Socket.io server bound to a random OS port.
 *   2. Live mode — connect to a running BuildForge server and log all events.
 *      Set WS_URL=http://localhost:3000 and SESSION_ID=<id> to use live mode.
 *
 * Run:  npx tsx src/websocket/test-ws-client.ts
 * Live: WS_URL=http://localhost:3000 SESSION_ID=abc npx tsx src/websocket/test-ws-client.ts
 */

import { createServer } from "http";
import { Server as IoServer, type Namespace } from "socket.io";
import { io as ioClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";

// ── Minimal event shape mirrors (no import from config chain) ─────────────────

interface BuildStartEvt   { sessionId: string; projectId: string; mode: string; timestamp: string; }
interface PhaseStartEvt   { sessionId: string; phase: string; agents: string[]; isParallel: boolean; timestamp: string; }
interface AgentStartEvt   { sessionId: string; agentType: string; taskName: string; timestamp: string; }
interface AgentCompleteEvt{ sessionId: string; agentType: string; creditsUsed?: number; timestamp: string; }
interface AgentErrorEvt   { taskId: string; sessionId: string; agentType: string; error: string; timestamp: string; }
interface CreditBurnEvt   { sessionId: string; userId: string; creditsUsed: number; totalCreditsUsed: number; timestamp: string; }
interface PhaseCompleteEvt{ sessionId: string; phase: string; nextPhase: string | null; creditsUsed: number; timestamp: string; }
interface ProgressEvt     { sessionId: string; percent: number; message: string; timestamp: string; }
interface BuildFailedEvt  { sessionId: string; phase: string; reason: string; logs: string; timestamp: string; }

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, err: unknown): void {
  console.error(`  ✗ ${label}:`, err instanceof Error ? err.message : String(err));
  failed++;
}

// ── In-process Socket.io test server ─────────────────────────────────────────

/**
 * Spin up a minimal Socket.io server on a random port, emit a scripted sequence
 * of build events to a connected client, and assert they arrive in correct order.
 */
async function runInProcessTest(): Promise<void> {
  console.log("\n── In-process WS event ordering tests ──");

  const httpServer = createServer();
  const ioServer = new IoServer(httpServer, { cors: { origin: "*" } });

  // Bind to OS-assigned port
  await new Promise<void>((res) => httpServer.listen(0, "127.0.0.1", res));
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") throw new Error("Failed to get server address");
  const port = addr.port;
  const url  = `http://127.0.0.1:${port}`;

  const buildNsp: Namespace = ioServer.of("/build");
  const SESSION  = "test-session-001";
  const ROOM     = `session:${SESSION}`;

  // ── Test 1: basic event receipt ──────────────────────────────────────────────

  const t1 = new Promise<void>((resolve, reject) => {
    const label = "Client receives build_start after joining session room";

    const client: ClientSocket = ioClient(`${url}/build`, { transports: ["websocket"] });

    client.on("connect", () => {
      client.emit("join_session", SESSION, (joined: boolean) => {
        try {
          assert(joined === true, "ack should be true");
          // Server emits the event after client joins
          buildNsp.to(ROOM).emit("build_start", {
            sessionId: SESSION, projectId: "proj-1", mode: "fast",
            timestamp: new Date().toISOString(),
          } satisfies BuildStartEvt);
        } catch (e) { reject(e); }
      });
    });

    client.on("build_start", (ev: BuildStartEvt) => {
      try {
        assert(ev.sessionId === SESSION, "sessionId matches");
        assert(ev.mode === "fast", "mode matches");
        ok(label);
        client.disconnect();
        resolve();
      } catch (e) { reject(e); }
    });

    client.on("connect_error", reject);
    setTimeout(() => reject(new Error("Timeout waiting for build_start")), 5_000);
  });

  buildNsp.on("connection", (socket) => {
    socket.on("join_session", (sid: string, ack: (ok: boolean) => void) => {
      void socket.join(`session:${sid}`);
      ack(true);
    });
  });

  try { await t1; } catch (e) { fail("Client receives build_start after joining session room", e); }

  // ── Test 2: event ordering ────────────────────────────────────────────────────

  const t2 = new Promise<void>((resolve, reject) => {
    const label = "Events arrive in correct order: build_start → phase_start → agent_start → agent_complete → phase_complete";

    const received: string[] = [];
    const client: ClientSocket = ioClient(`${url}/build`, { transports: ["websocket"] });

    const expected = ["build_start", "phase_start", "agent_start", "agent_complete", "phase_complete"];

    for (const evt of expected) {
      client.on(evt as Parameters<typeof client.on>[0], () => {
        received.push(evt);
        if (received.length === expected.length) {
          try {
            assert(
              JSON.stringify(received) === JSON.stringify(expected),
              `expected ${JSON.stringify(expected)}, got ${JSON.stringify(received)}`,
            );
            ok(label);
            client.disconnect();
            resolve();
          } catch (e) { reject(e); }
        }
      });
    }

    client.on("connect", () => {
      client.emit("join_session", SESSION, (_ack: boolean) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emit = (event: string, data: unknown) =>
          buildNsp.to(ROOM).emit(event as "build_start", data as any);

        const ts = new Date().toISOString();
        emit("build_start",    { sessionId: SESSION, projectId: "proj-1", mode: "fast", timestamp: ts });
        emit("phase_start",    { sessionId: SESSION, phase: "PLANNING", agents: ["architect"], isParallel: false, timestamp: ts });
        emit("agent_start",    { sessionId: SESSION, taskId: "t1", agentType: "planning", taskName: "Planning phase", model: "claude-opus-4-6", tier: 1, timestamp: ts });
        emit("agent_complete", { sessionId: SESSION, taskId: "t1", agentType: "planning", taskName: "Planning phase", outputPath: "", durationMs: 100, inputTokens: 50, outputTokens: 200, costUsd: 0.001, timestamp: ts });
        emit("phase_complete", { sessionId: SESSION, phase: "PLANNING", nextPhase: "BUILD", creditsUsed: 1, timestamp: ts });
      });
    });

    client.on("connect_error", reject);
    setTimeout(() => reject(new Error(`Timeout. Received: ${JSON.stringify(received)}`)), 5_000);
  });

  try { await t2; } catch (e) { fail("Events arrive in correct order: build_start → phase_start → agent_start → agent_complete → phase_complete", e); }

  // ── Test 3: credit_burn event ─────────────────────────────────────────────────

  const t3 = new Promise<void>((resolve, reject) => {
    const label = "credit_burn event carries creditsUsed and totalCreditsUsed";

    const client: ClientSocket = ioClient(`${url}/build`, { transports: ["websocket"] });

    client.on("connect", () => {
      client.emit("join_session", SESSION, (_ack: boolean) => {
        buildNsp.to(ROOM).emit("credit_burn", {
          sessionId: SESSION, userId: "user-1",
          creditsUsed: 5, totalCreditsUsed: 42,
          timestamp: new Date().toISOString(),
        } satisfies CreditBurnEvt);
      });
    });

    client.on("credit_burn", (ev: CreditBurnEvt) => {
      try {
        assert(ev.creditsUsed === 5,     "creditsUsed");
        assert(ev.totalCreditsUsed === 42, "totalCreditsUsed");
        ok(label);
        client.disconnect();
        resolve();
      } catch (e) { reject(e); }
    });

    client.on("connect_error", reject);
    setTimeout(() => reject(new Error("Timeout waiting for credit_burn")), 5_000);
  });

  try { await t3; } catch (e) { fail("credit_burn event carries creditsUsed and totalCreditsUsed", e); }

  // ── Test 4: agent_error interrupts sequence ───────────────────────────────────

  const t4 = new Promise<void>((resolve, reject) => {
    const label = "agent_error and build_failed events received after agent failure";

    const received: string[] = [];
    const client: ClientSocket = ioClient(`${url}/build`, { transports: ["websocket"] });

    client.on("agent_error",  () => received.push("agent_error"));
    client.on("build_failed", () => {
      received.push("build_failed");
      try {
        assert(received.includes("agent_error"),  "agent_error before build_failed");
        assert(received.includes("build_failed"), "build_failed present");
        ok(label);
        client.disconnect();
        resolve();
      } catch (e) { reject(e); }
    });

    client.on("connect", () => {
      client.emit("join_session", SESSION, (_ack: boolean) => {
        const ts = new Date().toISOString();
        buildNsp.to(ROOM).emit("agent_error", {
          taskId: "t2", sessionId: SESSION, agentType: "backend",
          error: "Model unreachable", timestamp: ts,
        } satisfies AgentErrorEvt);
        buildNsp.to(ROOM).emit("build_failed", {
          sessionId: SESSION, phase: "BUILD",
          reason: "Agent backend failed", logs: "", timestamp: ts,
        } satisfies BuildFailedEvt);
      });
    });

    client.on("connect_error", reject);
    setTimeout(() => reject(new Error(`Timeout. Received: ${JSON.stringify(received)}`)), 5_000);
  });

  try { await t4; } catch (e) { fail("agent_error and build_failed events received after agent failure", e); }

  // ── Test 5: progress events carry percent ─────────────────────────────────────

  const t5 = new Promise<void>((resolve, reject) => {
    const label = "progress events carry correct percent values";

    const percents: number[] = [];
    const client: ClientSocket = ioClient(`${url}/build`, { transports: ["websocket"] });

    client.on("progress", (ev: ProgressEvt) => {
      percents.push(ev.percent);
      if (percents.length === 3) {
        try {
          assert(percents[0]! < percents[1]!, "percent increases");
          assert(percents[2] === 100, "final percent is 100");
          ok(label);
          client.disconnect();
          resolve();
        } catch (e) { reject(e); }
      }
    });

    client.on("connect", () => {
      client.emit("join_session", SESSION, (_ack: boolean) => {
        const ts = new Date().toISOString();
        for (const pct of [33, 66, 100]) {
          buildNsp.to(ROOM).emit("progress", {
            sessionId: SESSION, percent: pct, message: `${pct}%`, timestamp: ts,
          } satisfies ProgressEvt);
        }
      });
    });

    client.on("connect_error", reject);
    setTimeout(() => reject(new Error(`Timeout. percents so far: ${JSON.stringify(percents)}`)), 5_000);
  });

  try { await t5; } catch (e) { fail("progress events carry correct percent values", e); }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  // ioServer.close() also closes the underlying httpServer; call only once
  await new Promise<void>((res) => ioServer.close(() => res()));
}

// ── Live mode: connect to running server ──────────────────────────────────────

async function runLiveMode(wsUrl: string, sessionId: string): Promise<void> {
  console.log(`\n── Live WS client — ${wsUrl} | session: ${sessionId} ──`);
  console.log("Listening for events… (Ctrl-C to exit)\n");

  const buildClient: ClientSocket = ioClient(`${wsUrl}/build`, {
    transports: ["websocket"],
    auth: { token: process.env["WS_AUTH_TOKEN"] ?? "" },
  });

  buildClient.on("connect", () => {
    console.log(`[connected] /build namespace`);
    buildClient.emit("join_session", sessionId, (joined: boolean) => {
      console.log(`[join_session] ${sessionId} → ${joined ? "joined" : "FAILED"}`);
    });
  });

  const ALL_EVENTS = [
    "build_start", "phase_start", "agent_start", "agent_progress",
    "agent_complete", "agent_error", "credit_burn", "file_update",
    "progress", "phase_complete", "build_failed", "plan_phase_start",
    "verify_result", "fix_required", "deploy_start", "deploy_complete",
  ] as const;

  const eventLog: Array<{ t: number; event: string; data: unknown }> = [];

  for (const ev of ALL_EVENTS) {
    buildClient.on(ev as Parameters<typeof buildClient.on>[0], (data: unknown) => {
      const entry = { t: Date.now(), event: ev, data };
      eventLog.push(entry);
      const ts = new Date(entry.t).toISOString().slice(11, 23);
      console.log(`[${ts}] ${ev.padEnd(20)} ${JSON.stringify(data).slice(0, 120)}`);
    });
  }

  buildClient.on("connect_error", (err) => console.error("[connect_error]", err.message));
  buildClient.on("disconnect",    (reason) => console.log("[disconnected]", reason));

  // Keep alive until interrupted
  await new Promise<void>((_, reject) => {
    process.on("SIGINT", () => {
      console.log(`\nReceived ${eventLog.length} total events. Disconnecting.`);
      buildClient.disconnect();
      reject(new Error("User interrupted"));
    });
  }).catch(() => undefined);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const WS_URL    = process.env["WS_URL"] ?? "";
const SESSION   = process.env["SESSION_ID"] ?? "";
const LIVE_MODE = WS_URL.length > 0 && SESSION.length > 0;

if (LIVE_MODE) {
  await runLiveMode(WS_URL, SESSION);
} else {
  await runInProcessTest();
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
