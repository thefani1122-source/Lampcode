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
/**
 * How many times a RATE_LIMIT may be retried against the SAME tier.
 *
 * Measured 2026-11-28 against Azure AI Foundry. The tier loop alone gives one
 * retry, because `MODEL_TIERS` has two entries and on the OpenAI-compatible
 * path both resolve to the same deployment. That was enough to kill a build in
 * seconds: the live logs show `delay: 3000` then `delay: 16000`, each followed
 * by `build_failed` 7 s and 21 s later. Four attempts spans a token window even
 * when the provider keeps asking for a short wait.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 4;

/**
 * The shortest wait worth making after a TOKEN-rate limit.
 *
 * `Retry-After` is designed for REQUEST-rate limits, where a few seconds really
 * does clear the window. A tokens-per-minute budget is different: the bucket
 * refills over a minute, so Azure answering `Retry-After: 3` is honest about
 * its own clock and useless for ours — measured 2026-11-28, the 3 s retry hit
 * the same 429 and the build died. Waiting less than this cannot succeed, so
 * the provider's hint is treated as a floor to raise, never a ceiling to trust.
 */
export const RATE_LIMIT_MIN_DELAY_MS = 20_000;

export function fallbackDelayMs(code: FallbackCode, retryAfterMs: number | undefined): number {
  const asked = retryAfterMs ?? 2_000;
  if (code !== "RATE_LIMIT") return Math.min(asked, 10_000);
  return Math.min(Math.max(asked, RATE_LIMIT_MIN_DELAY_MS), 65_000);
}
