/**
 * Cases for threat-model extraction (G2). Run by `npm test`.
 *
 * PLAN's definition of done for this is "different prompts produce genuinely
 * different checks". The failure that stops that is not a missing threat — it
 * is twelve true, useless sentences. Ask any model for security requirements
 * and it offers "use HTTPS", "validate all user input", "hash passwords",
 * "prevent SQL injection". Every one is correct, every one is already covered
 * by security.ts or is not ours to decide, and a list of them buries the one
 * requirement that actually belongs to this app.
 *
 * So most of these cases are about the filter, and they are written in both
 * directions: the boilerplate must go, and a real app-specific rule must
 * SURVIVE even when it happens to mention one of the same words. A filter that
 * eats real findings is worse than no filter, because it looks like it worked.
 */

import {
  THREAT_EXTRACTION_INSTRUCTION,
  formatThreatsForModel,
  formatThreatsForUser,
  isGenericThreat,
  parseThreats,
} from "../src/verify/threat-model.js";

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

// ── the boilerplate must go ──────────────────────────────────────────────────

for (const generic of [
  "Use HTTPS everywhere",
  "Validate all user input",
  "Sanitize user input before storing it",
  "Hash passwords with bcrypt",
  "Never store passwords in plain text",
  "Prevent SQL injection",
  "Protect against XSS and CSRF",
  "Use environment variables for secrets",
  "Do not commit secrets to the repository",
  "Enable RLS on every table",
  "Add authentication",
  "Implement rate limiting",
  "Keep dependencies up to date",
  "Apply the principle of least privilege",
]) {
  ok(`generic: "${generic}"`, isGenericThreat(generic));
}

ok("an empty statement is generic by definition", isGenericThreat("   "));

// ── and the real ones must survive ───────────────────────────────────────────
// These are the cases that matter. A filter that eats a real finding is worse
// than no filter, because it looks like it worked.

for (const specific of [
  "A clinician may only read appointments for patients assigned to them",
  "An employee may submit an expense claim but may not approve their own",
  "A voter may vote once per poll and nobody may see who voted for what",
  "A tenant may never read maintenance requests belonging to another unit",
  "The seller's payout account number must never reach the buyer's browser",
  "A student may not change the grade on their own submission",
]) {
  ok(`specific: "${specific.slice(0, 48)}…"`, !isGenericThreat(specific));
}

// The hard half: real rules that happen to contain a word the denylist uses.
ok(
  "validating a NAMED field is specific, not boilerplate",
  !isGenericThreat("Validate the claim amount is positive and under the team's limit"),
);
ok(
  "rate limiting a NAMED action is specific",
  !isGenericThreat("Implement rate limiting per voter so one person cannot stuff the poll"),
);
ok(
  "requiring auth BEFORE a named action is specific",
  !isGenericThreat("Require authentication before a doctor can open a patient record"),
);
ok(
  "an audit log someone must not see is specific",
  !isGenericThreat("The audit log must be readable only by an account owner"),
);

// ── parsing ──────────────────────────────────────────────────────────────────

const wrap = (threats: unknown) => JSON.stringify({ threats });

check(
  "a well-formed response parses and renumbers",
  parseThreats(
    wrap([
      { statement: "A clinician may only read their own patients' appointments", kind: "access" },
      { statement: "The booking endpoint must reject a date in the past", kind: "input" },
    ]),
  ).map((t) => [t.id, t.kind]),
  [["T1", "access"], ["T2", "input"]],
);

check("an unknown kind falls back to access", parseThreats(wrap([{ statement: "X may not read Y", kind: "nonsense" }]))[0]?.kind, "access");
check("a missing kind falls back to access", parseThreats(wrap([{ statement: "X may not read Y" }]))[0]?.kind, "access");

check(
  "boilerplate is stripped and counted, not returned",
  (() => {
    const stats = { dropped: 0, generic: 0 };
    const out = parseThreats(
      wrap([
        { statement: "Use HTTPS everywhere", kind: "exposure" },
        { statement: "A tenant may not read another unit's requests", kind: "access" },
        { statement: "Hash passwords with bcrypt", kind: "exposure" },
      ]),
      stats,
    );
    return [out.length, stats.generic];
  })(),
  [1, 2],
);

check(
  "duplicates differing only in spacing are one",
  parseThreats(
    wrap([
      { statement: "A tenant may not read another unit's requests", kind: "access" },
      { statement: "A  tenant   may not read another unit's requests", kind: "access" },
    ]),
  ).length,
  1,
);

check(
  "the cap holds and counts what it discarded",
  (() => {
    const stats = { dropped: 0, generic: 0 };
    const many = Array.from({ length: 12 }, (_, i) => ({ statement: `Actor ${i} may not read record ${i}`, kind: "access" }));
    const out = parseThreats(wrap(many), stats);
    return [out.length, stats.dropped];
  })(),
  [8, 4],
);

// Never throws, whatever arrives.
check("prose with no JSON yields nothing", parseThreats("I think the main risks are…"), []);
check("malformed JSON yields nothing", parseThreats('{"threats":[{'), []);
check("the wrong top-level key yields nothing", parseThreats(JSON.stringify({ criteria: [{ statement: "x" }] })), []);
check("an empty list yields nothing", parseThreats(wrap([])), []);
check("entries that are not objects are skipped", parseThreats(wrap(["a string", 42, null])), []);

// ── the instruction itself ───────────────────────────────────────────────────
// It is prompt text, so the only thing cases can hold is that the rules which
// make it work are still in it.

ok("the pass is told it will not write code", /not writing code/i.test(THREAT_EXTRACTION_INSTRUCTION));
ok("it demands the app's own nouns", /ITS nouns|THIS app/.test(THREAT_EXTRACTION_INSTRUCTION));
ok("it names WHO, WHAT, WHICH", /WHO must not do WHAT to WHICH/.test(THREAT_EXTRACTION_INSTRUCTION));
ok(
  "it forbids the exact boilerplate the filter drops",
  /Specifically forbidden[\s\S]*HTTPS[\s\S]*validate input[\s\S]*hash\s*\n?\s*passwords/i.test(THREAT_EXTRACTION_INSTRUCTION),
);
ok("it shows a good and a bad example", /Good:[\s\S]*Bad:/.test(THREAT_EXTRACTION_INSTRUCTION));
ok("it asks for JSON only", /Return JSON only/.test(THREAT_EXTRACTION_INSTRUCTION));

// ── output ───────────────────────────────────────────────────────────────────

check("the model's format is empty when there is nothing", formatThreatsForModel([]), "");
check("the user's format is empty when there is nothing", formatThreatsForUser([]), []);

{
  const t = parseThreats(wrap([{ statement: "A tenant may not read another unit's requests", kind: "access" }]));
  ok("the model is told these will be checked", /will be checked/i.test(formatThreatsForModel(t)));
  // Framed as understood, never as guaranteed: nothing is verified at this
  // point, and claiming otherwise is how a build reads as finished.
  ok("the user is told what was understood, not promised", /watch for/i.test(formatThreatsForUser(t)[0] ?? ""));
  ok("and the user never sees the word secure here", !formatThreatsForUser(t).join(" ").toLowerCase().includes("secure"));
}

console.log(
  failures === 0 ? "\nAll threat-model cases passed." : `\n${failures} threat-model case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
