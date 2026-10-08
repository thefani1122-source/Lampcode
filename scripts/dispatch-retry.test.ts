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
import { parseRetryAfter, mapModalError } from "../src/agents/modal-gateway.js";

let failures = 0;
const ok = (name: string, cond: boolean) => check(name, cond, true);
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

// ── Retry-After ─────────────────────────────────────────────────────────────
// The hardcoded 60 s guess is wrong in both directions: a per-second throttle
// clears far sooner, and an hourly quota does not clear at all, so waiting 60 s
// and retrying just burns the attempt. Measured 2026-10-08: this account was
// refused for over an hour and three separate runs each waited and died with
// nothing saying how long to wait.
const NOW = Date.parse("2026-10-08T03:00:00Z");

check("seconds are read as seconds", parseRetryAfter("30", NOW), 30_000);
check("zero seconds is honoured, not treated as absent", parseRetryAfter("0", NOW), 0);
check(
  "an HTTP date becomes the remaining milliseconds",
  parseRetryAfter("Thu, 08 Oct 2026 03:01:40 GMT", NOW),
  100_000,
);
// A date already in the past means "retry now", not "wait a negative time".
check("a past date clamps to zero", parseRetryAfter("Thu, 08 Oct 2026 02:00:00 GMT", NOW), 0);
check("an absent header yields nothing so the caller keeps its default", parseRetryAfter(null, NOW), undefined);
check("an empty header yields nothing", parseRetryAfter("", NOW), undefined);
check("nonsense yields nothing rather than NaN", parseRetryAfter("soon", NOW), undefined);
// A float is not a valid Retry-After and must not be half-read as 1 second.
check("a non-integer is rejected", parseRetryAfter("1.5", NOW), undefined);

// ── a 429 about money is not a rate limit ───────────────────────────────────
// The real body, captured from Modal on 2026-10-08 after four runs had each
// waited and failed without ever showing it:
const REAL_BILLING_BODY =
  '{"error":"Plan credits cannot be applied to shared endpoint usage. Add a payment method or increase your spend limit"}';

check(
  "a billing 429 is PAYMENT_REQUIRED, which is not retryable",
  mapModalError(429, REAL_BILLING_BODY).code,
  "PAYMENT_REQUIRED",
);
// The whole point of the reclassification: no wait, because waiting cannot help.
check(
  "a billing 429 carries no retry delay",
  mapModalError(429, REAL_BILLING_BODY).retryAfterMs,
  undefined,
);
ok(
  "a billing 429 keeps the provider's own words, so the owner knows what to do",
  mapModalError(429, REAL_BILLING_BODY).message.includes("Add a payment method"),
);
ok(
  "and says plainly that it is not load",
  mapModalError(429, REAL_BILLING_BODY).message.includes("not load"),
);

// A genuine throttle must still be retryable — misreading one as unpayable
// would stop a build that waiting would fix.
check(
  "a real throttle stays RATE_LIMIT",
  mapModalError(429, '{"error":"Too many requests, slow down"}').code,
  "RATE_LIMIT",
);
check(
  "a real throttle still honours Retry-After",
  mapModalError(429, "too many requests", "45").retryAfterMs,
  45_000,
);

// ── a 403 is not always a bad credential ────────────────────────────────────
// The real body, captured from Amazon Bedrock on 2026-10-08. The URL, the API
// key and the model id were ALL correct; only the AWS account was on hold.
const REAL_PENDING_BODY =
  '{"error":{"message":"Your account is currently being verified. Verification normally takes less than 2 hours. Until your account is verified, you may not have access to this operation."}}';

ok(
  "an account-verification 403 says the ACCOUNT is not cleared, not that the key is bad",
  mapModalError(403, REAL_PENDING_BODY).message.includes("ACCOUNT is not cleared"),
);
ok(
  "and says outright that it is not a code problem, so nobody re-debugs the gateway",
  mapModalError(403, REAL_PENDING_BODY).message.includes("not a code problem"),
);
ok(
  "and keeps AWS's own wording, including how long it normally takes",
  mapModalError(403, REAL_PENDING_BODY).message.includes("less than 2 hours"),
);

// The error in the other direction is worse: a revoked key called "pending"
// has the reader waiting for something that will never clear.
ok(
  "a genuinely rejected credential is still named as the credential",
  mapModalError(401, '{"error":"The security token included in the request is invalid"}')
    .message.includes("rejected the credential"),
);
check(
  "either way it stays INVALID_KEY — only the wording changes",
  mapModalError(403, REAL_PENDING_BODY).code,
  "INVALID_KEY",
);

// Every branch keeps the provider's message now. It used to be deleted on
// exactly the two that most need it.
ok(
  "a 401 reports what the provider said, not a guess about the token",
  mapModalError(401, '{"error":"token revoked"}').message.includes("token revoked"),
);
ok(
  "a 503 reports what the provider said",
  mapModalError(503, "upstream overloaded").message.includes("upstream overloaded"),
);

console.log(failures === 0 ? "\nAll dispatch-retry cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
