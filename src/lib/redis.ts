import { Redis, type RedisOptions } from "ioredis";

// Base options applied to every ioredis connection in the app.
// family: 0 — let the OS pick IPv4 or IPv6. Required for Railway's private
// networking where *.railway.internal resolves to an IPv6 address only.
const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  family: 0,
  // Do NOT queue commands issued while the connection is down. ioredis's
  // offline queue is unbounded, and maxRetriesPerRequest: null means a queued
  // command is never flushed with an error — so while Redis is unreachable
  // every command accumulates forever and none of the .catch() handlers at the
  // call sites ever run. Measured against a dead endpoint: 200 buffered build
  // events left 800 commands resident and produced zero rejections, which is
  // why a Redis outage lasting ~2 months logged nothing but reconnects.
  //
  // The cost is that the first command after process start is rejected with
  // "Stream isn't writeable", because the socket has not finished opening yet
  // (verified — eager connect does not avoid it either). Every call site in
  // this app already degrades on a Redis failure rather than propagating it
  // (rate-limit fails open, e2b-service cold-starts, the event buffer warns),
  // so one rejected command per client per boot is absorbed where it lands.
  enableOfflineQueue: false,
  // Retry up to 20 times with exponential back-off, cap at 30 s.
  retryStrategy: (times: number) => Math.min(times * 500, 30_000),
};

// A dead Redis reconnects on the retryStrategy's 30 s ceiling forever. Logging
// every attempt buries real diagnostics under ~5,800 lines a day, which is
// exactly how the outage above stayed invisible. Report a connection going bad
// once, then stay quiet until it recovers or a minute has passed.
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Create a single ioredis connection.
 *
 * Never throws — if REDIS_URL is absent the client targets localhost so the
 * process starts normally; Redis-dependent features will log errors and retry
 * in the background until the var is set and the service redeploys.
 */
export function createRedis(overrides: Partial<RedisOptions> = {}): Redis {
  // Accept REDIS_URL or REDIS_PUBLIC_URL — Railway may inject either name.
  const url = process.env["REDIS_URL"] ?? process.env["REDIS_PUBLIC_URL"];

  if (!url) {
    console.warn(
      "[redis] Neither REDIS_URL nor REDIS_PUBLIC_URL is set — " +
        "Redis-dependent features (BullMQ, interview sessions) will be unavailable " +
        "until the variable is configured in Railway → Variables.",
    );
  }

  const effective = url ?? "redis://localhost:6379";
  const client = new Redis(effective, { ...BASE_OPTIONS, ...overrides });

  const masked = effective.replace(/:\/\/[^@]+@/, "://***@");

  // Outage state, so the log describes a condition rather than each retry.
  let downSince: number | null = null;
  let suppressed = 0;
  let lastReported = 0;

  client.on("connect", () => {
    if (downSince === null) {
      console.log(`[redis] connected → ${masked}`);
      return;
    }
    const seconds = Math.round((Date.now() - downSince) / 1000);
    console.log(
      `[redis] reconnected → ${masked} after ${seconds}s down` +
        (suppressed > 0 ? ` (${suppressed} errors suppressed)` : ""),
    );
    downSince = null;
    suppressed = 0;
    lastReported = 0;
  });

  // Log errors but do NOT re-throw — ioredis will retry automatically.
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (downSince === null) {
      // First failure of this outage — always say so, and say it loudly,
      // because from here on the app is running without Redis.
      downSince = now;
      lastReported = now;
      console.error(
        `[redis] UNREACHABLE (${masked}): ${err.message} — ` +
          "rate limiting is now fail-open, sandbox IDs will not persist across " +
          "restarts, and build events are not being buffered for replay.",
      );
      return;
    }
    suppressed++;
    if (now - lastReported < ERROR_LOG_INTERVAL_MS) return;
    const minutes = Math.round((now - downSince) / 60_000);
    console.error(
      `[redis] still unreachable after ${minutes}m — ` +
        `${suppressed} errors since last report (latest: ${err.message})`,
    );
    lastReported = now;
    suppressed = 0;
  });

  // Open the socket now instead of on the first command. lazyConnect defers the
  // handshake until something is sent, and with the offline queue disabled that
  // first command loses the race and is rejected — Railway's healthcheck hits
  // /health within milliseconds of "Server listening", so every deploy logged
  // "[rate-limit] Redis unavailable — failing open" about a Redis that was
  // perfectly healthy. Connecting here gives the socket the whole startup to
  // open; measured, it removes the rejection even with only 50 ms of boot left.
  // Errors are reported by the handler above, so this catch stays empty.
  if (client.status === "wait") void client.connect().catch(() => {});

  return client;
}
