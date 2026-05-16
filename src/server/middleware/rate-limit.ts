import type { MiddlewareHandler } from "hono";
import { AppError } from "./error-handler.js";

interface BucketEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;

// Eviction interval: clear stale buckets every window to prevent unbounded growth
const buckets = new Map<string, BucketEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_MS).unref();

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const ip = getClientIp(c.req.raw);
  const now = Date.now();

  let bucket = buckets.get(ip);
  if (bucket === undefined || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }

  bucket.count += 1;

  c.header("X-RateLimit-Limit", String(MAX_REQUESTS));
  c.header("X-RateLimit-Remaining", String(Math.max(0, MAX_REQUESTS - bucket.count)));
  c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > MAX_REQUESTS) {
    throw new AppError(429, "Rate limit exceeded", "RATE_LIMIT_EXCEEDED");
  }

  await next();
};
