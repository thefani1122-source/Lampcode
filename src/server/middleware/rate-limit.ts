import type { MiddlewareHandler } from "hono";
import type { Result } from "ioredis";
import { AppError } from "./error-handler.js";
import { createRedis } from "../../lib/redis.js";
import { logger } from "../logger.js";

declare module "ioredis" {
  interface RedisCommander<Context> {
    incrExpire(key: string, windowSeconds: number): Result<[count: number, ttl: number], Context>;
  }
}

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
const MAX_REQUESTS = 100;
const KEY_PREFIX = "ratelimit:";

// A Redis blip must not cascade into a full outage: this middleware runs on
// every route including /health, and Railway's restartPolicy treats a failed
// healthcheck as reason to restart the service. Bound the wait so "fail open"
// actually means "open quickly" — createRedis()'s maxRetriesPerRequest: null
// means an unbounded call would otherwise queue for up to ~30s (the
// retryStrategy cap) before ever failing.
const REDIS_TIMEOUT_MS = 200;

// Atomic fixed-window increment, single round trip:
//  - INCR the key (creates it at 1 if absent)
//  - on the FIRST increment in a window, set its TTL to the window length
//  - otherwise read the remaining TTL, so X-RateLimit-Reset reflects the
//    real expiry instead of a value that would slide forward on every request
// Avoids the INCR-then-EXPIRE race of a two-command version, where a crash or
// dropped connection between the two calls leaves a key with no TTL.
const INCR_EXPIRE_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
local ttl
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
else
  ttl = redis.call("TTL", KEYS[1])
end
return {current, ttl}
`;

// Dedicated client for this concern, matching the one-client-per-module
// convention already used by e2b-service.ts / build-handler.ts / websocket
// server — not a second consumer of an unrelated module's instance.
const redis = createRedis();
redis.defineCommand("incrExpire", {
  numberOfKeys: 1,
  lua: INCR_EXPIRE_SCRIPT,
});

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim()).filter(Boolean);
    // Railway injects real client IP as last hop — use it to prevent spoofing
    return ips[ips.length - 1] ?? "unknown";
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err as Error); },
    );
  });
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const ip = getClientIp(c.req.raw);
  const key = `${KEY_PREFIX}${ip}`;

  let count: number;
  let ttlSeconds: number;
  try {
    [count, ttlSeconds] = await withTimeout(redis.incrExpire(key, WINDOW_SECONDS), REDIS_TIMEOUT_MS);
  } catch (err) {
    // Fail open: rate limiting stops enforcing for the duration of the outage.
    // Nothing cost-sensitive depends on this — MAX_BUILD_COST_USD (build.ts)
    // is a completely separate, Redis-independent spend ceiling.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), ip },
      "[rate-limit] Redis unavailable — failing open",
    );
    await next();
    return;
  }

  const remaining = Math.max(0, MAX_REQUESTS - count);
  const resetAt = Math.ceil(Date.now() / 1000) + ttlSeconds;

  c.header("X-RateLimit-Limit", String(MAX_REQUESTS));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(resetAt));

  if (count > MAX_REQUESTS) {
    throw new AppError(429, "Rate limit exceeded", "RATE_LIMIT_EXCEEDED");
  }

  await next();
};
