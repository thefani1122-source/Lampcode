import { readFileSync } from "node:fs";
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
  ok("the first build for a person asks", shouldAskForDatabase("user-a"));
  ok("the second does not", !shouldAskForDatabase("user-a"));
  // The case that was wrong before: keyed on the project, a person trying
  // three ideas in an afternoon was asked three separate times.
  ok("and a NEW project by the same person does not ask again", !shouldAskForDatabase("user-a"));
  ok("a different person is still asked", shouldAskForDatabase("user-b"));
  resetDatabasePromptMemory();
  ok("the memory is per process, not forever", shouldAskForDatabase("user-a"));
}


// ── The gate must not hang a build for ten minutes ──────────────────────────
// The shared ANSWER_TIMEOUT_MS is 10 minutes, which is right for "may I push to
// your GitHub?" and wrong for this: no answer here is not dangerous, it just
// means build without a database and say so. Someone who misses the card used
// to get ten minutes of silence.
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  ok("the database gate has its own timeout", build.includes("const DB_GATE_TIMEOUT_MS = 120_000;"));
  ok("and uses it, not the 10-minute approval timeout", build.includes("timeoutMs: DB_GATE_TIMEOUT_MS") && build.includes("setTimeout(() => done(null), DB_GATE_TIMEOUT_MS)"));
  ok("no answer is said out loud, not decided in silence", build.includes("No answer on the database yet"));
  ok("and the message says where the data will live", build.includes("keep its data in the browser"));
}


// ── The tables have to exist before anything looks at the app ───────────────
// The schema apply used to be `void getUserSupabaseMcpAuth(…).then(…)`: fire
// and forget. The preview, the interaction probe and the completion audit then
// drove an app whose tables might not exist yet — every query failing, the
// generated error handling turning that into an empty list, the app looking
// finished and empty. And the result reached ONE preview-log line and nothing
// else, so a failure scrolled past while the closing message said "complete".
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

  ok("the schema apply is awaited, not dropped", build.includes("const applied = await withTimeout(") && !build.includes("void getUserSupabaseMcpAuth(userId)"));
  ok("and bounded, so a slow database cannot hold the build", build.includes("SCHEMA_APPLY_TIMEOUT_MS"));
  ok("it happens before the preview chain starts", build.indexOf("applySupabaseSchema(auth") < build.indexOf("if (wantsE2BPreview) {"));
  ok("the result reaches the record", build.includes("...(schemaApply ? { schemaApply } : {})"));
  ok("a failure is logged with its reason", build.includes("[build] schema apply session="));

  // The three sentences a person needs, in their own words.
  ok("a failed apply is said out loud", build.includes("Tables: I could NOT create them in your Supabase"));
  ok("so is a schema with no database to go into", build.includes("there was no database to create it in"));
  ok("and a successful one", build.includes("created in your Supabase, so the app has somewhere real to save"));

  // A connected database with no tables in it is not a working one.
  ok("a failed apply stops the build claiming a real backend", build.includes("fs.schemaApply?.ok !== false"));
}

// Every table the app queries must be declared, because the schema is what is
// actually run against the user's database.
{
  const prompt = readFileSync(new URL("../src/agents/prompt-builder.ts", import.meta.url), "utf8");
  ok("the prompt demands every queried table be declared", prompt.includes("EVERY TABLE YOU QUERY MUST EXIST IN schema.sql"));
  ok("and says what happens when one is missing", prompt.includes("looks finished and empty"));
  ok("and asks the model to check its own routes", prompt.includes("read your own routes and check every"));
}

console.log(
  failures === 0 ? "\nAll database-prompt cases passed." : `\n${failures} database-prompt case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
