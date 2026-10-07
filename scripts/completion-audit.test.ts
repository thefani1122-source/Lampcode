/**
 * Cases for the completion audit's pure parts. Run by `npm test`.
 *
 * What these protect is one property: the audit may only move a requirement OFF
 * `unverified` by naming evidence that can be checked against the real file
 * list. Everything else — a missing entry, an unknown status, a confident
 * "proven" citing a file that does not exist, an unparseable reply — must come
 * back `unverified`.
 *
 * That matters more than the usual parser case. The audit's whole reason for
 * existing is Finding 4: a build rendered, type-checked, passed its own tests
 * and shipped no persistence over a prompt that said "Notes persist". If this
 * parser can be talked into "proven" by a model that invents a filename, the
 * audit becomes a second voice agreeing with the builder, which is worse than
 * having no audit at all — it would carry the authority of an outside check.
 */

import {
  parseCriteria,
  parseVerdicts,
  tallyVerdicts,
  unverifiedAudit,
  formatAuditForUser,
  formatFilesForAudit,
} from "../src/verify/completion-audit.js";
import type { AcceptanceCriterion } from "../src/db/schema.js";

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

// ── parseCriteria ────────────────────────────────────────────────────────────

check(
  "parseCriteria: plain object",
  parseCriteria('{"criteria":[{"text":"Notes persist","kind":"data"}]}'),
  [{ id: "R1", text: "Notes persist", kind: "data" }],
);

check(
  "parseCriteria: ```json fence and surrounding prose",
  parseCriteria('Here you go:\n```json\n{"criteria":[{"text":"Cmd+Z undoes","kind":"behaviour"}]}\n```\nHope that helps.'),
  [{ id: "R1", text: "Cmd+Z undoes", kind: "behaviour" }],
);

// Ids are renumbered, never trusted. A model that repeats "R1" would otherwise
// make two criteria collide in the verdict map and one would vanish silently —
// the one failure mode this module must not have.
check(
  "parseCriteria: duplicate model ids are renumbered, not collided",
  parseCriteria('{"criteria":[{"id":"R1","text":"A"},{"id":"R1","text":"B"},{"id":"R9","text":"C"}]}')
    .map((c) => c.id),
  ["R1", "R2", "R3"],
);

check(
  "parseCriteria: unknown kind falls back to behaviour",
  parseCriteria('{"criteria":[{"text":"X","kind":"vibes"}]}')[0]?.kind,
  "behaviour",
);

check(
  "parseCriteria: missing kind falls back to behaviour",
  parseCriteria('{"criteria":[{"text":"X"}]}')[0]?.kind,
  "behaviour",
);

check(
  "parseCriteria: blank and non-string text dropped",
  parseCriteria('{"criteria":[{"text":"  "},{"text":7},{"text":"real"}]}').length,
  1,
);

check(
  "parseCriteria: same text twice is one criterion",
  parseCriteria('{"criteria":[{"text":"Notes persist"},{"text":"notes PERSIST"}]}').length,
  1,
);

check("parseCriteria: empty string", parseCriteria(""), []);
check("parseCriteria: prose with no JSON", parseCriteria("I could not do that."), []);
check("parseCriteria: malformed JSON", parseCriteria('{"criteria":[{"text":'), []);
check("parseCriteria: criteria not an array", parseCriteria('{"criteria":"lots"}'), []);
check("parseCriteria: wrong top-level key", parseCriteria('{"requirements":[{"text":"X"}]}'), []);

check(
  "parseCriteria: capped at 18",
  parseCriteria(
    JSON.stringify({ criteria: Array.from({ length: 40 }, (_, i) => ({ text: `req ${i}` })) }),
  ).length,
  18,
);

// ── parseVerdicts: the fail-closed property ──────────────────────────────────

const CRITERIA: AcceptanceCriterion[] = [
  { id: "R1", text: "Notes persist across reloads", kind: "data" },
  { id: "R2", text: "Cmd+Z undoes the last edit", kind: "behaviour" },
];
const PATHS = ["src/App.tsx", "src/lib/storage.ts", "src/lib/storage.test.ts"];

check(
  "parseVerdicts: proven with a real file stands",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"proven","evidence":"src/lib/storage.ts","note":"writes on change"},{"id":"R2","status":"unverified","evidence":"","note":"no handler"}]}',
    CRITERIA,
    PATHS,
  ).map((v) => [v.id, v.status]),
  [["R1", "proven"], ["R2", "unverified"]],
);

// The case that matters most. A model justifying itself with a file it never
// saw must not thereby mark a missing requirement as done.
check(
  "parseVerdicts: proven citing a file that does not exist is downgraded",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"proven","evidence":"src/lib/persistence.ts","note":"handles it"}]}',
    CRITERIA,
    PATHS,
  )[0],
  {
    id: "R1",
    status: "unverified",
    evidence: "",
    note: 'claimed proven citing "src/lib/persistence.ts", which is not in this project',
  },
);

check(
  "parseVerdicts: proven with no evidence is downgraded",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"proven","evidence":"","note":"it is there"}]}', CRITERIA, PATHS)[0]
    ?.status,
  "unverified",
);

check(
  "parseVerdicts: a gate name is acceptable evidence",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"proven","evidence":"run_tests"}]}', CRITERIA, PATHS)[0]?.status,
  "proven",
);

check(
  "parseVerdicts: an invented gate name is not",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"proven","evidence":"check_persistence"}]}', CRITERIA, PATHS)[0]
    ?.status,
  "unverified",
);

check(
  "parseVerdicts: path:line and a leading ./ still resolve",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"proven","evidence":"./src/lib/storage.ts:42"}]}',
    CRITERIA,
    PATHS,
  )[0]?.status,
  "proven",
);

check(
  "parseVerdicts: several citations, one real, is enough",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"proven","evidence":"src/nope.ts, src/lib/storage.ts"}]}',
    CRITERIA,
    PATHS,
  )[0]?.status,
  "proven",
);

// ── contradicted has to be corroborated ─────────────────────────────────────
// Measured on a real build, 2026-10-07: the auditor reported in precise detail
// that NotesView named-imported a component which "only has export default",
// that the prop names disagreed, and that markdownToHtml was never called. All
// three were false. The file has a named export, the prop matches, and the
// function is called inside it — and check_page, check_types and run_tests had
// all passed. Nothing could tell that verdict apart from a real one, and the
// user would have been shown "NOT DONE" over working code.
//
// So a complaint must quote the line it is complaining about, and the quote is
// looked up in the real file. These cases are that false positive, kept as a
// regression.
const PROJECT = {
  "src/App.tsx": "export default function App() { return null }",
  "src/components/Preview.tsx":
    "import { markdownToHtml } from '../lib/markdown'\nexport function Preview({ note }: { note: Note }) {\n  const html = markdownToHtml(note.content)\n  return <div>{html}</div>\n}",
  "src/lib/storage.ts": "export const loadNotes = () => JSON.parse(localStorage.getItem('n') ?? '[]')",
};
const P_CRITERIA: AcceptanceCriterion[] = [
  { id: "R1", text: "Shows a markdown preview beside the editor", kind: "visual" },
];

check(
  "parseVerdicts: the real false positive is downgraded, not shown as NOT DONE",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","quote":"export default function Preview","note":"only has export default, so the named import fails"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "unverified",
);

check(
  "parseVerdicts: a contradicted claim whose quote IS in the file stands",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","quote":"export function Preview({ note }: { note: Note })","note":"renders the raw string, not parsed markdown"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "contradicted",
);

// The model retypes what it read; it will not reproduce indentation or line
// wrapping, so matching has to ignore whitespace or the check rejects honest
// complaints and the feature is useless.
check(
  "parseVerdicts: a quote matches across reflowed whitespace",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","quote":"const html  =   markdownToHtml(note.content)","note":"x"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "contradicted",
);

check(
  "parseVerdicts: contradicted with no quote at all is downgraded",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","note":"feels wrong"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "unverified",
);

// A quote short enough to appear in any file proves nothing — "}" would pass.
check(
  "parseVerdicts: a too-short quote does not corroborate",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","quote":"return","note":"x"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "unverified",
);

check(
  "parseVerdicts: a quote found in a DIFFERENT file than the one cited does not count",
  parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","quote":"export const loadNotes = () => JSON.parse","note":"x"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.status,
  "unverified",
);

// The downgrade keeps the complaint visible: something made the auditor stop,
// and the user should see that nobody has shown this works.
ok(
  "parseVerdicts: a downgraded complaint still carries what was reported",
  (parseVerdicts(
    '{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/components/Preview.tsx","note":"only has export default"}]}',
    P_CRITERIA,
    PROJECT,
  )[0]?.note ?? "").includes("only has export default"),
);

// Paths-only callers (every stored run from before contents were passed, and
// the cases above) cannot corroborate anything, and must fail safe.
check(
  "parseVerdicts: with paths only, a contradicted claim cannot be corroborated",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"contradicted","evidence":"src/App.tsx","quote":"whatever it says here"}]}', CRITERIA, PATHS)[0]?.status,
  "unverified",
);

check(
  "parseVerdicts: a criterion the audit ignored is unverified",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"proven","evidence":"src/App.tsx"}]}', CRITERIA, PATHS)[1],
  { id: "R2", status: "unverified", evidence: "", note: "the audit did not cover this" },
);

check(
  "parseVerdicts: an unknown status is unverified",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"probably fine","note":"looks ok"}]}', CRITERIA, PATHS)[0]?.status,
  "unverified",
);

check(
  "parseVerdicts: unparseable reply leaves every criterion unverified",
  parseVerdicts("the model refused", CRITERIA, PATHS).map((v) => v.status),
  ["unverified", "unverified"],
);

check(
  "parseVerdicts: every criterion always gets exactly one verdict",
  parseVerdicts('{"verdicts":[{"id":"R1","status":"proven","evidence":"src/App.tsx"},{"id":"R7","status":"proven","evidence":"src/App.tsx"}]}', CRITERIA, PATHS)
    .map((v) => v.id),
  ["R1", "R2"],
);

check(
  "parseVerdicts: lowercase id from the model still matches",
  parseVerdicts('{"verdicts":[{"id":"r1","status":"proven","evidence":"src/App.tsx"}]}', CRITERIA, PATHS)[0]?.status,
  "proven",
);

// ── tally and the unverified-audit shape ─────────────────────────────────────

check(
  "tallyVerdicts counts the three states",
  tallyVerdicts([
    { id: "R1", status: "proven", evidence: "a", note: "" },
    { id: "R2", status: "unverified", evidence: "", note: "" },
    { id: "R3", status: "contradicted", evidence: "", note: "" },
    { id: "R4", status: "unverified", evidence: "", note: "" },
  ]),
  { proven: 1, contradicted: 1, unverified: 2 },
);

check(
  "unverifiedAudit: nothing is proven when the audit could not run",
  (() => {
    const a = unverifiedAudit(CRITERIA, "the audit could not run");
    return [a.proven, a.unverified, a.verdicts.length, a.verdicts[0]?.note];
  })(),
  [0, 2, 2, "the audit could not run"],
);

// ── formatAuditForUser ───────────────────────────────────────────────────────

check(
  "formatAuditForUser: a clean audit says so in one line",
  formatAuditForUser({
    criteria: CRITERIA,
    verdicts: [
      { id: "R1", status: "proven", evidence: "src/lib/storage.ts", note: "" },
      { id: "R2", status: "proven", evidence: "src/App.tsx", note: "" },
    ],
    proven: 2,
    contradicted: 0,
    unverified: 0,
    costUsd: 0.01,
  }),
  ["Checked against your request: all 2 requirement(s) verified."],
);

const mixed = formatAuditForUser({
  criteria: CRITERIA,
  verdicts: [
    { id: "R1", status: "proven", evidence: "src/lib/storage.ts", note: "" },
    { id: "R2", status: "unverified", evidence: "", note: "no keyboard handler anywhere" },
  ],
  proven: 1,
  contradicted: 0,
  unverified: 1,
  costUsd: 0.01,
});

// The user must be able to read what is missing in their own words — the whole
// point is that "done" stops being said over an unproven requirement.
ok("formatAuditForUser: names the unverified requirement in the user's words",
  mixed.some((l) => l.includes("Cmd+Z undoes the last edit")));
ok("formatAuditForUser: labels it UNVERIFIED", mixed.some((l) => l.includes("UNVERIFIED")));
ok("formatAuditForUser: carries the reason", mixed.some((l) => l.includes("no keyboard handler")));
// A proven requirement is not listed: the list is what needs attention, and
// restating the passes would bury the one line that matters.
ok("formatAuditForUser: proven requirements are not listed",
  !mixed.some((l) => l.includes("Notes persist")));
ok("formatAuditForUser: says what unverified means",
  mixed.some((l) => l.includes("does not mean broken")));

check(
  "formatAuditForUser: no criteria means no output at all",
  formatAuditForUser({ criteria: [], verdicts: [], proven: 0, contradicted: 0, unverified: 0, costUsd: 0 }),
  [],
);

const contradicted = formatAuditForUser({
  criteria: [CRITERIA[0] as AcceptanceCriterion],
  verdicts: [{ id: "R1", status: "contradicted", evidence: "src/App.tsx", note: "plain useState" }],
  proven: 0,
  contradicted: 1,
  unverified: 0,
  costUsd: 0,
});
ok("formatAuditForUser: contradicted reads NOT DONE, not UNVERIFIED",
  contradicted.some((l) => l.includes("NOT DONE")) && !contradicted.some((l) => l.includes("UNVERIFIED")));

// ── formatFilesForAudit ──────────────────────────────────────────────────────

const excerpt = formatFilesForAudit({
  "src/App.tsx": "const App = () => null;",
  "src/lib/storage.ts": "localStorage.setItem('k','v');",
});
ok("formatFilesForAudit: every path is labelled", excerpt.includes("--- src/App.tsx ---") && excerpt.includes("--- src/lib/storage.ts ---"));
ok("formatFilesForAudit: content is included", excerpt.includes("localStorage.setItem"));

// Breadth over depth: the failure being hunted is a requirement with no
// implementation ANYWHERE, so a single huge file must not push the small ones
// out of the excerpt entirely.
const withHuge = formatFilesForAudit({
  "src/huge.ts": "x".repeat(400_000),
  "src/small.ts": "export const KEEP = 1;",
});
ok("formatFilesForAudit: a small file survives next to a 400 KB one",
  withHuge.includes("export const KEEP = 1;"));
ok("formatFilesForAudit: the huge file is truncated, not dropped",
  withHuge.includes("--- src/huge.ts ---") && withHuge.includes("(truncated)"));
ok("formatFilesForAudit: total stays within budget", withHuge.length < 120_000);

console.log(failures === 0 ? "\nAll completion-audit cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
