/** Cases for when a write drags a page check along with it. Run by `npm test`.
 *
 * The one that matters most is `never`: a model can write for an entire build
 * without once looking at the page, and `writesAfterCheckPage` is blind to it
 * because that counter does not start until `checkPage` has been set once. A
 * rule that only watched the counter would miss the worse failure entirely. */
import { autoCheckReason, MAX_WRITES_BEFORE_AUTO_CHECK } from "../src/verify/auto-check.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

// No gate tracking at all — the non-agentic path. Nothing is owed and nothing
// should be spent; this must not become a sweep on a path that has no sandbox.
check("no gate object asks for nothing", autoCheckReason(undefined), null);

// The page has never been looked at. This is the case the counter cannot see.
check("never checked", autoCheckReason({}), "never");
check("never checked, even after many writes", autoCheckReason({ writesAfterCheckPage: 9 }), "never");

// A fresh verdict. The model checked after its own write — it must not be
// charged for a second sweep immediately.
check("just checked", autoCheckReason({ checkPage: "pass", writesAfterCheckPage: 0 }), null);
check("one write since", autoCheckReason({ checkPage: "pass", writesAfterCheckPage: 1 }), null);
check(
  "just under the threshold",
  autoCheckReason({ checkPage: "pass", writesAfterCheckPage: MAX_WRITES_BEFORE_AUTO_CHECK - 1 }),
  null,
);

// The measured shape: three writes on a one-check verdict.
check(
  "at the threshold",
  autoCheckReason({ checkPage: "pass", writesAfterCheckPage: MAX_WRITES_BEFORE_AUTO_CHECK }),
  "stale",
);
check("well past it", autoCheckReason({ checkPage: "pass", writesAfterCheckPage: 12 }), "stale");

// A FAILING verdict goes stale exactly like a passing one. If anything this
// matters more: the model was told something was broken, wrote three times,
// and may well have fixed it — telling it the old failure again would send it
// chasing a bug that no longer exists.
check(
  "a failing verdict also goes stale",
  autoCheckReason({ checkPage: "fail", writesAfterCheckPage: MAX_WRITES_BEFORE_AUTO_CHECK }),
  "stale",
);

// "unavailable" means the sweep could not run, which is NOT a verdict about
// the page. Treating it as one is how an agent ships a blank app believing it
// verified one — so it must still count as having been checked for staleness
// purposes, and the counter decides.
check(
  "unavailable then writes is stale, not never",
  autoCheckReason({ checkPage: "unavailable", writesAfterCheckPage: 5 }),
  "stale",
);

// Counter missing while a verdict exists: treat as fresh rather than stale.
// Guessing "stale" here would sweep on every write for any caller that does
// not maintain the counter, which is the expensive direction to be wrong in.
check("verdict with no counter is not stale", autoCheckReason({ checkPage: "pass" }), null);

console.log(failures === 0 ? "\nAll auto-check cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
