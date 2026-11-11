/**
 * Cases for scoreChecks. There is no test runner in this repo, so this is a
 * plain script — `npm test` runs it alongside the vitest-parser cases. It
 * prints each case and exits non-zero if any fails.
 *
 * It exists because the scoring is the part that silently decides what counts
 * as a good build. A check that a correct build can fail turns the harness into
 * a worse signal than no harness at all, so these cases pin the behaviour that
 * matters: template-owned files don't count toward minFiles but are a finding
 * on their own, "never" and "unavailable" stay distinct from "fail", and a
 * regex miss reads as a miss.
 */

import { scoreChecks, scoreJourney, type BuildOutcome, type FileEntry, type EvalJourneyReport } from "./score.js";
import type { EvalTask } from "./tasks.js";

const f = (path: string, content: string): FileEntry => ({
  path,
  content,
  lines: content.split("\n").length,
});

const task = (over: Partial<EvalTask>): EvalTask => ({
  id: "t",
  title: "t",
  tier: "smoke",
  prompt: "p",
  ...over,
});

const outcome = (over: Partial<BuildOutcome> = {}): BuildOutcome => ({
  rounds: 3,
  turnsExhausted: false,
  filesWritten: 2,
  toolCalls: {},
  checkPage: "pass",
  checkTypes: "pass",
  checkTests: "none",
  costUsd: 0.1,
  durationMs: 1000,
  ...over,
});

let failures = 0;
function expectChecks(name: string, got: string[], want: string[]): void {
  const ok =
    got.length === want.length &&
    want.every((w) => got.some((g) => g.includes(w)));
  if (!ok) {
    failures++;
    console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else {
    console.log(`✔ ${name}`);
  }
}

// A clean build with everything the task asked for.
expectChecks(
  "clean build passes",
  scoreChecks(
    task({ mustContain: ["localStorage"], minFiles: 2 }),
    [f("src/App.tsx", "localStorage.setItem('a','b')"), f("src/components/Row.tsx", "export const Row = () => null")],
    outcome(),
  ),
  [],
);

// The one-file problem: works, but the next edit rewrites the whole app.
expectChecks(
  "minFiles catches a single-file app",
  scoreChecks(
    task({ minFiles: 4 }),
    [f("src/App.tsx", "everything")],
    outcome(),
  ),
  ["only 1 file(s)"],
);

// Template-owned files are a finding AND must not pad the file count — the
// whole point of minFiles is counting the model's own components.
expectChecks(
  "template-owned files don't count toward minFiles",
  scoreChecks(
    task({ minFiles: 3 }),
    [
      f("src/App.tsx", "app"),
      f("src/styles.css", "@theme {}"),
      f("vite.config.ts", "export default {}"),
    ],
    outcome(),
  ),
  ["overwrote template-owned file: src/styles.css", "overwrote template-owned file: vite.config.ts", "only 1 file(s)"],
);

// mustContain accepts a regex as well as a string.
expectChecks(
  "regex mustContain misses are reported",
  scoreChecks(
    task({ mustContain: [/recharts|chart/i] }),
    [f("src/App.tsx", "a plain table, no graph at all")],
    outcome(),
  ),
  ["missing:"],
);
expectChecks(
  "regex mustContain hits are not reported",
  scoreChecks(
    task({ mustContain: [/recharts|chart/i] }),
    [f("src/App.tsx", "import { LineChart } from 'recharts'")],
    outcome(),
  ),
  [],
);

expectChecks(
  "mustNotContain fires on a hit",
  scoreChecks(
    task({ mustNotContain: ["TODO: implement"] }),
    [f("src/App.tsx", "// TODO: implement this later")],
    outcome(),
  ),
  ["present but shouldn't be"],
);

// minTestFiles — only set on tasks whose logic warrants a test.
expectChecks(
  "minTestFiles catches a build with no tests",
  scoreChecks(
    task({ minTestFiles: 1 }),
    [f("src/lib/formula.ts", "export const evaluate = () => 0")],
    outcome(),
  ),
  ["0 test file(s)"],
);
expectChecks(
  "minTestFiles is satisfied by a .test.ts file",
  scoreChecks(
    task({ minTestFiles: 1 }),
    [
      f("src/lib/formula.ts", "export const evaluate = () => 0"),
      f("src/lib/formula.test.ts", "import { it } from 'vitest'"),
    ],
    outcome(),
  ),
  [],
);
expectChecks(
  "minTestFiles accepts .test.tsx too",
  scoreChecks(
    task({ minTestFiles: 1 }),
    [f("src/components/Grid.test.tsx", "import { it } from 'vitest'")],
    outcome(),
  ),
  [],
);
// A source file merely NAMED like a test must not count — and a task with no
// minTestFiles must never be scored on tests at all.
expectChecks(
  "a file named latest.ts is not a test file",
  scoreChecks(
    task({ minTestFiles: 1 }),
    [f("src/lib/latest.ts", "export const latest = 1")],
    outcome(),
  ),
  ["0 test file(s)"],
);
expectChecks(
  "a task without minTestFiles is not scored on tests",
  scoreChecks(task({}), [f("src/App.tsx", "app")], outcome()),
  [],
);

expectChecks(
  "maxLinesPerFile catches a 2000-line App.tsx",
  scoreChecks(
    task({ maxLinesPerFile: 400 }),
    [f("src/App.tsx", "x\n".repeat(900)), f("src/ok.tsx", "small")],
    outcome(),
  ),
  ["src/App.tsx is 901 lines"],
);

// The three gate states are distinct findings, because they mean three
// different things and collapsing them is exactly how a structurally broken
// check_page read as a model problem.
expectChecks(
  "check_page failure is a finding",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ checkPage: "fail" })),
  ["check_page ended on a failure"],
);
expectChecks(
  "check_page unavailable is its own finding",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ checkPage: "unavailable" })),
  ["check_page could not run"],
);
expectChecks(
  "check_page never called is reported, not scored as a failure",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ checkPage: "never" })),
  [],
);
// The outside check. Separate from the gate findings on purpose: a gate
// failure means something ran and complained, while an unverified requirement
// means nothing in the build covers what the user asked for — the state that
// let editor-undo pass every gate with no persistence in it.
expectChecks(
  "an unverified requirement is a finding",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ unverifiedCount: 2 })),
  ["2 requirement(s) from the prompt are unverified"],
);
expectChecks(
  "zero unverified is not a finding",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ unverifiedCount: 0 })),
  [],
);
// Rows written before the audit existed have no such key, and reading one must
// not invent a finding — the eval has to be able to read its own history.
expectChecks(
  "an outcome from before the audit existed scores nothing for it",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({})),
  [],
);

expectChecks(
  "turnsExhausted is a finding",
  scoreChecks(task({}), [f("src/App.tsx", "a")], outcome({ turnsExhausted: true })),
  ["ran out of turns"],
);

// A build with no recorded outcome (pipeline path, or an older session) must
// not be penalised for gates it never had.
expectChecks(
  "a missing outcome scores no gate findings",
  scoreChecks(task({ minFiles: 1 }), [f("src/App.tsx", "a")], null),
  [],
);

// Paths come back from the API relative, but tolerate a "./" prefix.
expectChecks(
  "./-prefixed template paths are still recognised",
  scoreChecks(task({}), [f("./src/styles.css", "@theme {}")], outcome()),
  ["overwrote template-owned file"],
);

// Independent browser journey scoring. Unavailable infrastructure must not
// be counted as a bad generated app, while an actual failed step must.
const journeyTask = task({
  journey: [
    { do: "click", text: "Increase" },
    { do: "expect", text: "1" },
  ],
});
const journeyReport = (over: Partial<EvalJourneyReport> = {}): EvalJourneyReport => ({
  ran: true,
  steps: [
    { step: 1, did: 'click "Increase"', ok: true, detail: "" },
    { step: 2, did: 'expect "1"', ok: true, detail: "" },
  ],
  consoleErrors: [],
  finalUrl: "http://localhost/",
  ...over,
});
const journeyExpect = (name: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else {
    console.log(`✔ ${name}`);
  }
};
journeyExpect(
  "tasks without a journey remain explicitly not requested",
  scoreJourney(task({}), null).verdict,
  "not-requested",
);
journeyExpect(
  "browser infrastructure unavailable is not an app failure",
  scoreJourney(journeyTask, { ...journeyReport(), ran: false, steps: [], reason: "no live preview" }).verdict,
  "unavailable",
);
journeyExpect(
  "a browser journey that completes all expected steps passes",
  scoreJourney(journeyTask, journeyReport()).verdict,
  "pass",
);
journeyExpect(
  "a concrete failed journey step is a finding",
  scoreJourney(journeyTask, journeyReport({
    steps: [
      { step: 1, did: 'click "Increase"', ok: true, detail: "" },
      { step: 2, did: 'expect "1"', ok: false, detail: '"1" is not on the page' },
    ],
  })).verdict,
  "fail",
);
journeyExpect(
  "a partial journey without an infrastructure reason does not pass",
  scoreJourney(journeyTask, journeyReport({ steps: [{ step: 1, did: "click", ok: true, detail: "" }] })).verdict,
  "fail",
);
journeyExpect(
  "console errors during a completed journey are findings",
  scoreJourney(journeyTask, journeyReport({ consoleErrors: ["TypeError: state is undefined"] })).verdict,
  "fail",
);
journeyExpect(
  "journey score records expected and completed steps",
  scoreJourney(journeyTask, journeyReport()).stepsRun,
  2,
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
