/**
 * Cases for the fallback delay. Run by `npm test`.
 *
 * Small surface, real bug. modal-gateway.ts reports `retryAfterMs: 60_000` for
 * a 429, and the dispatcher capped every fallback delay at 10 s — so on the
 * OpenAI-compatible path, where BOTH TIERS resolve to the same endpoint because
 * the model name comes from LLM_MODEL_NAME rather than MODEL_TIERS, the
 * "fallback" was a retry against the same throttled endpoint 10 s into a 60 s
 * window. Measured twice on 2026-10-07: builds failed outright at 25 s and 27 s
 * with build_outcome null, because the first dispatch never returned.
 */

import { fallbackDelayMs } from "../src/agents/retry-policy.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

// The regression: a 429 asking for 60 s must get 60 s, not 10.
check("a rate limit waits as long as the provider asked", fallbackDelayMs("RATE_LIMIT", 60_000), 60_000);
check("a rate limit is still bounded", fallbackDelayMs("RATE_LIMIT", 10 * 60_000), 65_000);
check("a rate limit with no hint falls back to the default", fallbackDelayMs("RATE_LIMIT", undefined), 2_000);

// The short cap is right for these: the next tier is a DIFFERENT model, so
// trying it at once is the point and a long stall buys nothing.
check("a down model keeps the short cap", fallbackDelayMs("MODEL_DOWN", 60_000), 10_000);
check("an unknown error keeps the short cap", fallbackDelayMs("UNKNOWN", 60_000), 10_000);
check("a short hint is honoured as given", fallbackDelayMs("MODEL_DOWN", 1_500), 1_500);

console.log(failures === 0 ? "\nAll dispatch-retry cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
