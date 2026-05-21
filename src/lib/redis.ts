import { Redis, type RedisOptions } from "ioredis";

// Base options applied to every ioredis connection in the app.
// family: 0 — let the OS pick IPv4 or IPv6. Required for Railway's private
// networking where *.railway.internal resolves to an IPv6 address only.
const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  family: 0,
  // Retry up to 20 times with exponential back-off, cap at 30 s.
  retryStrategy: (times: number) => Math.min(times * 500, 30_000),
};

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

  client.on("connect", () => {
    const masked = effective.replace(/:\/\/[^@]+@/, "://***@");
    console.log(`[redis] connected → ${masked}`);
  });

  // Log errors but do NOT re-throw — ioredis will retry automatically.
  client.on("error", (err: Error) => {
    console.error(`[redis] error: ${err.message}`);
  });

  return client;
}
