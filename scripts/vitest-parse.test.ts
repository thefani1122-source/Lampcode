/**
 * Cases for parseVitestOutput — the function that decides whether the agent's
 * tests passed.
 *
 * No test runner in this repo, so this is a plain script — `npm test` runs it
 * alongside the eval scoring cases. Non-zero exit if a case fails.
 *
 * The fixtures under fixtures/vitest/ are REAL output: vitest 2.1 was installed
 * in a scratch project holding the template's own package.json, vitest.config.ts
 * and vitest.setup.ts, then run through the exact shell command runTests sends
 * to the sandbox — a mixed pass/fail suite, an all-passing suite, a project with
 * no test files, and a failing component test. Hand-written fixtures would only
 * prove the parser agrees with my guess about the format. The only edit made to
 * them is the scratch directory rewritten to /home/user/app, the real sandbox
 * path, which changes no structure and makes the stack frames representative.
 *
 * Why this is worth cases of its own: a parser that reads a FAILING run as a
 * pass hands the agent proof of correctness it never earned, which is worse
 * than having no test tool at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVitestOutput } from "../src/preview/e2b-service.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "vitest");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

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

// ── Real vitest output ────────────────────────────────────────────────────────

const mixed = parseVitestOutput(fixture("mixed.out"));
check("mixed run: outcome", mixed.outcome, "failed");
check("mixed run: counts", [mixed.total, mixed.passed, mixed.failed], [3, 2, 1]);
check("mixed run: one failure collected", mixed.failures.length, 1);
// vitest's `fullName` joins the describe chain with a single space, not " > ".
check(
  "mixed run: failure names the test, not the file",
  mixed.failures[0]?.test,
  "withTax adds 8% sales tax",
);
// The message has to carry the actual numbers, or the model is told a test
// failed without being told what it expected.
const msg = mixed.failures[0]?.message ?? "";
check("mixed run: message keeps expected/received", /120/.test(msg) && /108/.test(msg), true);
// The assertion plus the one frame inside the project — the node_modules
// frames are long sandbox paths the model can do nothing with, and they are
// the bulk of a raw vitest message.
check("mixed run: message is the assertion plus one frame", msg.split("\n").length, 2);
check("mixed run: keeps the frame in the project's own file", /totals\.test\.ts:\d+/.test(msg), true);
check("mixed run: drops node_modules frames", /node_modules/.test(msg), false);

// A component test fails with a different message shape — @testing-library
// prints a multi-line "Unable to find an element" report plus a DOM dump.
const componentFail = parseVitestOutput(fixture("component-fail.out"));
check("component failure: outcome", componentFail.outcome, "failed");
const cmsg = componentFail.failures[0]?.message ?? "";
check(
  "component failure: keeps what testing-library said",
  /Unable to find an element/i.test(cmsg),
  true,
);
check("component failure: drops node_modules frames", /node_modules/.test(cmsg), false);
// The DOM dump is useful but unbounded; it must not be allowed to run away.
check("component failure: message stays bounded", cmsg.split("\n").length <= 10, true);

const passed = parseVitestOutput(fixture("pass.out"));
check("all passing: outcome", passed.outcome, "passed");
check("all passing: counts", [passed.total, passed.passed, passed.failed], [3, 3, 0]);
check("all passing: no failures listed", passed.failures.length, 0);

const none = parseVitestOutput(fixture("none.out"));
check("no test files: outcome is none, NOT passed", none.outcome, "none");
check("no test files: nothing counted", [none.total, none.passed, none.failed], [0, 0, 0]);

// ── The ways the run can fail to produce a report ─────────────────────────────

const notInstalled = parseVitestOutput(
  "sh: 1: vitest: not found\n__LAMPCODE_VITEST_EXIT__127\n",
);
check("vitest missing: outcome", notInstalled.outcome, "unavailable");
check(
  "vitest missing: reason says so plainly",
  /not installed in this sandbox/.test(notInstalled.reason ?? ""),
  true,
);

const crashed = parseVitestOutput(
  "Error: Cannot find module './vitest.setup.ts'\n__LAMPCODE_VITEST_EXIT__1\n",
);
check("startup crash: outcome", crashed.outcome, "unavailable");

// No marker at all — the command itself never ran (sandbox trouble). Must not
// read as a pass.
const noMarker = parseVitestOutput("");
check("empty output: outcome", noMarker.outcome, "unavailable");

// A report truncated mid-write must not be read as a pass either.
const truncated = parseVitestOutput(
  '__LAMPCODE_VITEST_EXIT__0\n{"numTotalTests":3,"numPassedTests":3,"testRes',
);
check("truncated report: outcome", truncated.outcome, "unavailable");

// A report that parses but counts nothing is "none", not "passed": vitest can
// collect zero tests from a file that only contains a skipped describe.
const zeroTests = parseVitestOutput(
  '__LAMPCODE_VITEST_EXIT__0\n{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"testResults":[]}',
);
check("report with zero tests: outcome", zeroTests.outcome, "none");

// Console noise before the marker must not be mistaken for the report, and a
// test's own console.log must not break the split.
const noisy = parseVitestOutput(
  'stdout | src/a.test.ts\n{"this":"is a test\'s own log, not the report"}\n' +
  'JSON report written to /tmp/lampcode-vitest.json\n' +
  '__LAMPCODE_VITEST_EXIT__0\n' +
  '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"testResults":[]}',
);
check("a test's own JSON log does not shadow the report", noisy.outcome, "passed");
check("noisy run: counts come from the report", [noisy.total, noisy.passed], [1, 1]);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
