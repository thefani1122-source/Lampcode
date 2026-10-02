/**
 * Cases for scoreChecks. There is no test runner in this repo (`npm test`
 * exits 1), so this is a script: `npx tsx scripts/eval/score.test.ts`. It
 * prints each case and exits non-zero if any fails.
 *
 * It exists because the scoring is the part that silently decides what counts
 * as a good build. A check that a correct build can fail turns the harness into
 * a worse signal than no harness at all, so these cases pin the behaviour that
 * matters: template-owned files don't count toward minFiles but are a finding
 * on their own, "never" and "unavailable" stay distinct from "fail", and a
 * regex miss reads as a miss.
 */

import { scoreChecks, type BuildOutcome, type FileEntry } from "./score.js";
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

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
