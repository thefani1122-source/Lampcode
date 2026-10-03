/**
 * Cases for the eval harness's auth. Run by `npm test`.
 *
 * Both halves of this fail quietly if they are wrong. A refresh margin that is
 * too lazy shows up as a 401 at minute 58 of a sixty-minute run, with the
 * report blaming the tasks. Credential resolution picking the wrong source
 * shows up as a run that used a stale token nobody meant to use.
 */

import { needsRefresh, createTokenProvider } from "./auth.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.log(`✘ ${name}\n    got:  ${g}\n    want: ${w}`);
  } else {
    console.log(`✔ ${name}`);
  }
}

// ── needsRefresh ──────────────────────────────────────────────────────────────

const now = 1_700_000_000_000;
const session = (msFromNow: number) => ({
  accessToken: "t", refreshToken: "r", expiresAt: now + msFromNow,
});
const MIN = 60_000;

check("a fresh token is left alone", needsRefresh(session(55 * MIN), now), false);
check("a token expiring in an hour is left alone", needsRefresh(session(60 * MIN), now), false);
// The margin is the whole point: a request issued just under the wire must not
// land just over it.
check("a token inside the 5-minute margin is refreshed", needsRefresh(session(4 * MIN), now), true);
check("a token exactly at the margin is refreshed", needsRefresh(session(5 * MIN), now), true);
check("an already-expired token is refreshed", needsRefresh(session(-1 * MIN), now), true);
check("a token expiring this instant is refreshed", needsRefresh(session(0), now), true);
check("the margin is configurable", needsRefresh(session(10 * MIN), now, 15 * MIN), true);

// ── createTokenProvider: which credential wins ────────────────────────────────

const withToken = createTokenProvider({ EVAL_TOKEN: "pasted-token" });
check("EVAL_TOKEN is used as-is", await withToken.token(), "pasted-token");
// It cannot be refreshed, and a run longer than its life will break. Say so
// rather than letting it look equivalent to signing in.
check(
  "EVAL_TOKEN says out loud that it cannot refresh",
  /cannot be refreshed/.test(withToken.describe()),
  true,
);
check(
  "surrounding whitespace on a pasted token is trimmed",
  await createTokenProvider({ EVAL_TOKEN: "  pasted-token\n" }).token(),
  "pasted-token",
);
// An empty EVAL_TOKEN must not count as "provided" and shadow a working
// email/password pair — that would be a confusing way to get a 401.
check(
  "an empty EVAL_TOKEN falls through to sign-in",
  createTokenProvider({
    EVAL_TOKEN: "   ", EVAL_EMAIL: "a@b.c", EVAL_PASSWORD: "p", EVAL_SUPABASE_ANON_KEY: "k",
  }).describe(),
  "signed in as a@b.c (refreshes itself)",
);

// ── createTokenProvider: refusals ─────────────────────────────────────────────

function refusal(env: Record<string, string | undefined>): string {
  try {
    createTokenProvider(env);
    return "NO ERROR THROWN";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

check(
  "no credentials at all explains both options",
  /EVAL_EMAIL and EVAL_PASSWORD/.test(refusal({})) && /EVAL_TOKEN/.test(refusal({})),
  true,
);
check(
  "an email with no password is refused",
  /EVAL_EMAIL and EVAL_PASSWORD/.test(refusal({ EVAL_EMAIL: "a@b.c" })),
  true,
);
check(
  "a missing anon key is its own message, not the generic one",
  /EVAL_SUPABASE_ANON_KEY is not set/.test(
    refusal({ EVAL_EMAIL: "a@b.c", EVAL_PASSWORD: "p" }),
  ),
  true,
);
// The anon key is public and people hesitate over anything key-shaped. The
// message has to say that, or it reads like a request for a secret.
check(
  "the anon-key message says it is public, not a secret",
  /not a secret/.test(refusal({ EVAL_EMAIL: "a@b.c", EVAL_PASSWORD: "p" })),
  true,
);
// A password must never reach a log line or an error string.
check(
  "no refusal message leaks the password",
  refusal({ EVAL_EMAIL: "a@b.c", EVAL_PASSWORD: "hunter2" }).includes("hunter2"),
  false,
);
check(
  "describe() does not leak the password either",
  createTokenProvider({
    EVAL_EMAIL: "a@b.c", EVAL_PASSWORD: "hunter2", EVAL_SUPABASE_ANON_KEY: "k",
  }).describe().includes("hunter2"),
  false,
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
