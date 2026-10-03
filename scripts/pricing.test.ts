/**
 * Cases for computeUsage. Run by `npm test`.
 *
 * This is the function that decides what a build cost, which feeds the cost
 * guard that aborts builds, the credits deducted from a user, and any price
 * ever set from `usage_usd`. It had no cases at all, and it has been wrong in
 * both directions:
 *
 *  - On the OpenAI-compatible path it billed every input token at the full
 *    rate, so an agentic build resending the conversation each round was
 *    overstated several times over — the provider dashboard read $0.42 across a
 *    day while this put one build at $0.555.
 *  - On the Anthropic path it read only `input_tokens`, which EXCLUDES cache
 *    reads and cache writes, so cache reads — most of an agentic build's input —
 *    were billed as free.
 *
 * The two providers' conventions differ, which is why the contract is that
 * `inputTokens` is the TOTAL and the cache figures are subsets of it.
 */

import { TokenTracker } from "../src/agents/token-tracker.js";

const t = new TokenTracker();

let failures = 0;
function near(name: string, got: number, want: number, tol = 1e-9): void {
  if (Math.abs(got - want) <= tol) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${got}\n    want: ${want}`);
}
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

// Kimi K3, the model actually serving builds: $3.00 input / $15.00 output per
// MTok, cached prompt $0.30 — a tenth, which is what CACHED_INPUT_RATIO assumes
// when a row declares no explicit cached rate.
const KIMI = "moonshotai/kimi-k3";

// ── No cache: the simple case ─────────────────────────────────────────────────

near(
  "fresh input and output are priced at the headline rates",
  t.computeUsage(KIMI, 1_000_000, 1_000_000).costUsd,
  3.0 + 15.0,
);
near("zero tokens cost nothing", t.computeUsage(KIMI, 0, 0).costUsd, 0);

// ── Cache reads are a discount, and they are a subset of the total ────────────

// 1M prompt tokens of which 900k came from cache: 100k fresh at $3 + 900k at
// $0.30. Billing all of it fresh would be $3.00 — the overstatement that
// aborted a build at a ceiling it had not reached.
near(
  "a mostly-cached prompt costs a fraction of a fresh one",
  t.computeUsage(KIMI, 1_000_000, 0, 900_000).costUsd,
  0.1 * 3.0 + 0.9 * 0.3,
);
check(
  "the cached count is reported back",
  t.computeUsage(KIMI, 1_000_000, 0, 900_000).cachedInputTokens,
  900_000,
);
near(
  "a fully-cached prompt is billed entirely at the cached rate",
  t.computeUsage(KIMI, 1_000_000, 0, 1_000_000).costUsd,
  0.3,
);

// Defensive: a provider reporting more cached than total, or a negative, must
// not produce a negative bill or a credit.
near(
  "cached above the total is clamped, never negative",
  t.computeUsage(KIMI, 100_000, 0, 500_000).costUsd,
  0.1 * 0.3,
);
near(
  "a negative cached count is ignored",
  t.computeUsage(KIMI, 1_000_000, 0, -5_000).costUsd,
  3.0,
);

// ── Cache writes are a PREMIUM, not a discount ───────────────────────────────
// Anthropic bills a cache write at 1.25x input. Treating it as a discount, or
// ignoring it, both understate the first round of a cached conversation.

near(
  "a cache write costs more than fresh input, not less",
  t.computeUsage(KIMI, 1_000_000, 0, 0, 1_000_000).costUsd,
  3.0 * 1.25,
);
near(
  "reads and writes in one call are priced separately",
  // 1M total: 200k written at 1.25x, 700k read at 0.1x, 100k fresh.
  t.computeUsage(KIMI, 1_000_000, 0, 700_000, 200_000).costUsd,
  0.1 * 3.0 + 0.7 * 0.3 + 0.2 * 3.0 * 1.25,
);
near(
  "a write that would overflow the total is clamped against the read",
  t.computeUsage(KIMI, 100_000, 0, 90_000, 500_000).costUsd,
  0.09 * 0.3 + 0.01 * 3.0 * 1.25,
);

// ── The convention that makes the two providers comparable ───────────────────
// An Anthropic round reporting input_tokens=1k, cache_read=99k is normalised by
// the gateway to promptTokens=100k with cachedPromptTokens=99k. Priced that way
// it is cheap; priced the OLD way — input_tokens alone, cache read dropped —
// the 99k would have been free.
const anthropicNormalised = t.computeUsage(KIMI, 100_000, 0, 99_000).costUsd;
const anthropicOldWay = t.computeUsage(KIMI, 1_000, 0, 0).costUsd;
near("normalised Anthropic usage prices the cache read", anthropicNormalised, 0.001 * 3.0 + 0.099 * 0.3);
check(
  "dropping the cache read would have under-billed",
  anthropicOldWay < anthropicNormalised,
  true,
);

// ── An unknown model must not silently bill as free ──────────────────────────

const unknown = t.computeUsage("some-model-nobody-priced", 1_000_000, 1_000_000);
check("an unknown model still produces a non-zero cost", unknown.costUsd > 0, true);
// Model ids arrive with whatever casing a dashboard uses; a miss would fall
// back to a guess, so the lookup is case-insensitive.
near(
  "model lookup is case-insensitive",
  t.computeUsage("moonshotai/Kimi-K3", 1_000_000, 0).costUsd,
  t.computeUsage(KIMI, 1_000_000, 0).costUsd,
);

check(
  "totalTokens is input plus output",
  t.computeUsage(KIMI, 1_000, 500).totalTokens,
  1_500,
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
