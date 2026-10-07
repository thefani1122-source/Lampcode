/**
 * How long to wait before trying the next model tier.
 *
 * Its own module, with no imports, so the cases for it can run without loading
 * the server's graph. `scripts/dispatch-retry.test.ts` first imported this from
 * `dispatcher.ts` and `npm test` then printed a Redis warning — a suite that is
 * meant to need no credentials had started pulling config, Redis and the model
 * clients in to check one arithmetic rule. Same lesson as `review-units.ts`
 * copying the baked-file list instead of importing it.
 */

export type FallbackCode = "RATE_LIMIT" | "MODEL_DOWN" | "UNKNOWN";

export const FALLBACK_CODES = new Set<FallbackCode>(["RATE_LIMIT", "MODEL_DOWN", "UNKNOWN"]);

export function isFallbackCode(code: string): code is FallbackCode {
  return FALLBACK_CODES.has(code as FallbackCode);
}

/**
 * A rate limit is the one case where the provider TELLS you how long to wait,
 * and the old code threw that away: it capped every delay at 10 s while
 * `modal-gateway.ts` reports `retryAfterMs: 60_000` for a 429.
 *
 * That cap was invisible on Anthropic, where tier 2 is a different model, but
 * on the OpenAI-compatible path BOTH TIERS RESOLVE TO THE SAME ENDPOINT — the
 * model name comes from `LLM_MODEL_NAME`, not from `MODEL_TIERS` — so the
 * "fallback" is really a retry against the same throttled endpoint, 10 s into a
 * 60 s window. Measured twice on 2026-10-07: a build failed outright at 25 s
 * and another at 27 s with "Modal rate limit exceeded", `build_outcome` null
 * both times because the first dispatch never returned. Every user build that
 * met a 429 died inside half a minute instead of waiting it out.
 *
 * MODEL_DOWN and UNKNOWN keep the short cap: there the next tier is a different
 * model, so trying it at once is the point and a long stall buys nothing.
 */
export function fallbackDelayMs(code: FallbackCode, retryAfterMs: number | undefined): number {
  const asked = retryAfterMs ?? 2_000;
  return code === "RATE_LIMIT" ? Math.min(asked, 65_000) : Math.min(asked, 10_000);
}
