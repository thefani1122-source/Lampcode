/**
 * When a write should bring a page check back with it.
 *
 * Its own module, and pure, for a reason that is a trap in this repo: anything
 * importing `tools.ts` pulls in `e2b-service.ts`, which pulls in config, Redis
 * and the E2B SDK and HANGS outside the server process (CLAUDE.md, trap 9). A
 * decision that cannot be tested is a decision nobody will change later with
 * any confidence, so it lives where `npm test` can reach it.
 */

/**
 * How many writes may pile up on a stale page verdict before the next write
 * carries a check with it.
 *
 * Three, because that is what a real build did. The multi-page build on
 * 2026-10-15 called `write_files` three times and `edit_file` once, called
 * `check_page` exactly once, and finished with `checkPage: "pass"` — a verdict
 * about code three writes older than what shipped. `staleCheckPage` has
 * recorded that shape for a while and nothing ever acted on it.
 */
export const MAX_WRITES_BEFORE_AUTO_CHECK = 3;

export type AutoCheckReason = "never" | "stale" | null;

/**
 * Deliberately NOT "every write".
 *
 * The sweep costs roughly 1.7s plus 0.95s per route, so running it after all of
 * them would add most of a minute to a build that is already slow, mostly to
 * re-answer a question nobody asked. It fires on the two shapes that are
 * actually wrong:
 *
 *   `never` — code has been written and the page has never once been looked at.
 *   `writesAfterCheckPage` cannot see this, because that counter only starts
 *   incrementing once `checkPage` has been set at least once; before the first
 *   check it stays undefined no matter how much is written.
 *
 *   `stale` — a verdict exists but describes code the build no longer has.
 *
 * Returns null when nothing is owed, which is the common case for a model that
 * checks after its own writes — it should never pay for this twice.
 */
export function autoCheckReason(gate: {
  checkPage?: string | undefined;
  writesAfterCheckPage?: number | undefined;
} | undefined): AutoCheckReason {
  if (!gate) return null;
  if (!gate.checkPage) return "never";
  if ((gate.writesAfterCheckPage ?? 0) >= MAX_WRITES_BEFORE_AUTO_CHECK) return "stale";
  return null;
}
