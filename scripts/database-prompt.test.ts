/**
 * Cases for the "connect your Supabase" gate. Run by `npm test`.
 *
 * Two properties matter more than the rest here, and both are about what the
 * gate must NOT do.
 *
 * It must not read a refusal as consent. "don't connect anything" contains the
 * word connect, and a gate that treats that as yes would point someone's build
 * at a database they explicitly declined — so the decline patterns are checked
 * first, and the cases pin that ordering rather than trusting it.
 *
 * And it must not nag. A person who said no gets asked once per project; a gate
 * that reappears on every follow-up message is one people learn to click past
 * without reading, which is worse than no gate at all.
 */

import {
  CONNECT_LABEL,
  DECLINE_LABEL,
  buildDatabaseQuestion,
  interpretDatabaseAnswer,
  resetDatabasePromptMemory,
  shouldAskForDatabase,
} from "../src/server/database-prompt.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

// ── the question ─────────────────────────────────────────────────────────────

{
  const { question, options } = buildDatabaseQuestion();

  ok("the question says what happens to THEIR app", /save data/i.test(question));
  check("there are exactly two options", options.length, 2);
  check("connecting is the recommended one", options[0]?.recommended, true);
  check("connecting carries the connect action", options[0]?.action, "connect-supabase");
  check("declining carries no action", options[1]?.action, undefined);

  // Declining has to be a real, listed choice. A gate whose only button is
  // "yes" is not a question, and the person would be stuck on a build they
  // never asked to pause.
  ok("declining is offered explicitly", options.some((o) => o.label === DECLINE_LABEL));
  ok(
    "declining says plainly that nothing is kept",
    /will not be kept/i.test(options[1]?.description ?? ""),
  );
}

// ── reading the answer ───────────────────────────────────────────────────────

check("the connect button means connect", interpretDatabaseAnswer(CONNECT_LABEL), "connect");
check("the decline button means decline", interpretDatabaseAnswer(DECLINE_LABEL), "decline");

// The ordering case. Every one of these contains a word the connect branch
// matches, and every one of them is a no.
check("'no, skip it' is a decline", interpretDatabaseAnswer("no, skip it"), "decline");
check("'don't connect anything' is a decline", interpretDatabaseAnswer("don't connect anything"), "decline");
check("'not now' is a decline", interpretDatabaseAnswer("not now"), "decline");
check("'without a database' is a decline", interpretDatabaseAnswer("continue without a database"), "decline");
check("'maybe later' is a decline", interpretDatabaseAnswer("maybe later"), "decline");

check("'done' is a connect", interpretDatabaseAnswer("done"), "connect");
check("'connected it' is a connect", interpretDatabaseAnswer("connected it"), "connect");
check("'ok ready' is a connect", interpretDatabaseAnswer("ok ready"), "connect");
check("Hinglish 'kar diya' is a connect", interpretDatabaseAnswer("kar diya"), "connect");
check("Hinglish 'nahi' is a decline", interpretDatabaseAnswer("nahi"), "decline");

// A timeout and an empty box are the same thing: no answer. Neither may be
// read as a yes, because a yes here changes where someone's data goes.
check("a timeout is unclear, never a yes", interpretDatabaseAnswer(null), "unclear");
check("an empty answer is unclear", interpretDatabaseAnswer("   "), "unclear");
check("something off-topic is unclear", interpretDatabaseAnswer("make it blue"), "unclear");

// ── asking at most once ──────────────────────────────────────────────────────

{
  resetDatabasePromptMemory();
  ok("the first build in a project asks", shouldAskForDatabase("proj-a"));
  ok("the second one does not", !shouldAskForDatabase("proj-a"));
  ok("and the third does not either", !shouldAskForDatabase("proj-a"));
  ok("a different project is still asked", shouldAskForDatabase("proj-b"));
  resetDatabasePromptMemory();
  ok("the memory is per process, not forever", shouldAskForDatabase("proj-a"));
}

console.log(
  failures === 0 ? "\nAll database-prompt cases passed." : `\n${failures} database-prompt case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
