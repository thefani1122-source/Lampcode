import { Redis, type RedisOptions } from "ioredis";

// Base options applied to every ioredis connection in the app.
// family: 0 — let the OS pick IPv4 or IPv6. Required for Railway's private
// networking where *.railway.internal resolves to an IPv6 address only.
const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  family: 0,
};

/**
 * Create a single ioredis connection from REDIS_URL.
 * All Redis/BullMQ connections in the app must go through here so the
 * IPv6 + retry options are applied consistently.
 */
export function createRedis(overrides: Partial<RedisOptions> = {}): Redis {
  const url = process.env["REDIS_URL"];
  if (!url) {
    throw new Error(
      "REDIS_URL is not set. Add it in Railway → Variables (use the Redis service reference, not the private URL directly).",
    );
  }

  const client = new Redis(url, { ...BASE_OPTIONS, ...overrides });

  client.on("connect", () => {
    const masked = url.replace(/:\/\/[^@]+@/, "://***@");
    console.log(`[redis] connected → ${masked}`);
  });
  client.on("error", (err: Error) => {
    console.error(`[redis] error: ${err.message}`);
  });

  return client;
}
