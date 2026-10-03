/**
 * Cases for the build planner's pure parts: who gets a planning pass, and what
 * survives parsing a model's answer.
 *
 * No test runner in this repo, so this is a plain script — `npm test` runs it.
 * Non-zero exit if a case fails.
 *
 * Both functions decide things silently. `shouldPlan` spends money when it says
 * yes and leaves a long build unplanned when it says no; `parsePlan` is handed
 * free-form model output and has to refuse a plan that would make the build
 * worse — one naming template-owned files, or an empty one that would put a
 * "planned files" heading with nothing under it into the build prompt.
 */

import { shouldPlan, parsePlan, formatPlanForPrompt } from "../src/agents/build-planner.js";

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

// ── shouldPlan ────────────────────────────────────────────────────────────────

const longPrompt = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
const shortPrompt = "build me a counter app";

check(
  "a long new agentic build is planned",
  shouldPlan({ prompt: longPrompt, hasExistingCode: false, agenticBuild: true, minWords: 60 }),
  true,
);
// An edit already has a layout — the project's own. Planning one again invites
// the model to restructure a working app.
check(
  "an edit is never planned, however long the prompt",
  shouldPlan({ prompt: longPrompt, hasExistingCode: true, agenticBuild: true, minWords: 60 }),
  false,
);
// The pipeline emits one shot of fenced files and never reads a plan, so
// planning for it would be paid for and thrown away.
check(
  "the pipeline path is never planned",
  shouldPlan({ prompt: longPrompt, hasExistingCode: false, agenticBuild: false, minWords: 60 }),
  false,
);
check(
  "a short build is not planned",
  shouldPlan({ prompt: shortPrompt, hasExistingCode: false, agenticBuild: true, minWords: 60 }),
  false,
);
// Exactly at the threshold counts — otherwise the documented number is off by
// one from the behaviour.
const exactly60 = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
check(
  "a prompt of exactly minWords is planned",
  shouldPlan({ prompt: exactly60, hasExistingCode: false, agenticBuild: true, minWords: 60 }),
  true,
);
check(
  "one word short of the threshold is not planned",
  shouldPlan({
    prompt: Array.from({ length: 59 }, (_, i) => `w${i}`).join(" "),
    hasExistingCode: false, agenticBuild: true, minWords: 60,
  }),
  false,
);
// Whitespace must not inflate the count into a planning pass.
check(
  "runs of whitespace do not count as words",
  shouldPlan({
    prompt: "  build    a\n\n\tcounter   ", hasExistingCode: false, agenticBuild: true, minWords: 4,
  }),
  false,
);

// Measured 2026-10-03: word count cannot separate complexity — the eval tiers
// overlap (hard 41-62, core 38-51, smoke 29-50). The old 60-word bar let only
// 1 of 5 hard builds plan. So length is a low bar now, and these signals force
// a plan for a prompt that is terse but structurally large.

check(
  "a terse prompt naming four views still plans",
  shouldPlan({
    prompt: "A CRM with four views behind a sidebar.",
    hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  true,
);
check(
  "a digit count works as well as a word",
  shouldPlan({
    prompt: "An app with 5 screens.", hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  true,
);
check(
  "three distinct screen nouns plan without a count",
  shouldPlan({
    prompt: "Build a dashboard, a kanban and a settings area.",
    hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  true,
);
check(
  "two screen nouns are not enough on their own",
  shouldPlan({
    prompt: "A dashboard with a sidebar.", hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  false,
);
// The spreadsheet case: 53 words under the old bar, no plan, 3 files.
check(
  "a terse prompt with hard logic plans",
  shouldPlan({
    prompt: "A grid where a cell starting with = evaluates a formula.",
    hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  true,
);
check(
  "undo/redo counts as hard logic",
  shouldPlan({
    prompt: "A note editor with undo and redo.", hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  true,
);
// A genuine one-liner still must not pay for a plan.
check(
  "a trivial one-liner does not plan",
  shouldPlan({
    prompt: "Build a counter with plus and minus buttons.",
    hasExistingCode: false, agenticBuild: true, minWords: 38,
  }),
  false,
);
// The exclusions still win over every signal above.
check(
  "an edit never plans even when it names four views",
  shouldPlan({
    prompt: "A CRM with four views and a formula evaluator.",
    hasExistingCode: true, agenticBuild: true, minWords: 38,
  }),
  false,
);
check(
  "the pipeline never plans even when it names four views",
  shouldPlan({
    prompt: "A CRM with four views and a formula evaluator.",
    hasExistingCode: false, agenticBuild: false, minWords: 38,
  }),
  false,
);

// ── parsePlan ─────────────────────────────────────────────────────────────────

const bare = parsePlan(JSON.stringify({
  summary: "A client tracker.",
  files: [
    { path: "src/types.ts", purpose: "shared types" },
    { path: "src/views/Dashboard.tsx", purpose: "KPI cards" },
  ],
  outOfScope: ["email notifications"],
}));
check("bare JSON parses", bare?.files.length, 2);
check("summary is kept", bare?.summary, "A client tracker.");
check("order is preserved", bare?.files.map((f) => f.path), ["src/types.ts", "src/views/Dashboard.tsx"]);
check("outOfScope is kept", bare?.outOfScope, ["email notifications"]);

// Models fence and preamble their JSON however firmly the prompt says not to.
check(
  "a ```json fence parses",
  parsePlan('```json\n{"summary":"x","files":[{"path":"src/App.tsx","purpose":"shell"}]}\n```')?.files.length,
  1,
);
check(
  "prose around the JSON parses",
  parsePlan('Here is the plan:\n{"summary":"x","files":[{"path":"src/a.ts","purpose":"p"}]}\nHope that helps!')
    ?.files.length,
  1,
);

// Refusals. Each of these would make the build worse than no plan at all.
check("malformed JSON is refused", parsePlan("{not json at all"), null);
check("empty output is refused", parsePlan(""), null);
check("prose with no JSON is refused", parsePlan("I think you should start with the types."), null);
check(
  "a plan with no files is refused",
  parsePlan(JSON.stringify({ summary: "x", files: [] })),
  null,
);
check(
  "a plan whose only files are template-owned is refused",
  parsePlan(JSON.stringify({ summary: "x", files: [{ path: "src/styles.css", purpose: "styles" }] })),
  null,
);

// Template-owned files are dropped rather than failing the whole plan — a plan
// that names one would otherwise have the build try to write it, be refused,
// and read that refusal as a failure.
const withTemplate = parsePlan(JSON.stringify({
  summary: "x",
  files: [
    { path: "src/styles.css", purpose: "styles" },
    { path: "vite.config.ts", purpose: "config" },
    { path: "package.json", purpose: "deps" },
    { path: "src/App.tsx", purpose: "shell" },
  ],
}));
check("template-owned files are dropped", withTemplate?.files.map((f) => f.path), ["src/App.tsx"]);

check(
  "a leading ./ or / is normalised away",
  parsePlan(JSON.stringify({ summary: "x", files: [{ path: "./src/a.ts", purpose: "p" }] }))
    ?.files[0]?.path,
  "src/a.ts",
);
check(
  "duplicate paths are collapsed",
  parsePlan(JSON.stringify({
    summary: "x",
    files: [
      { path: "src/a.ts", purpose: "first" },
      { path: "src/a.ts", purpose: "second" },
    ],
  }))?.files.length,
  1,
);
check(
  "a file with no purpose still counts, with a stated placeholder",
  parsePlan(JSON.stringify({ summary: "x", files: [{ path: "src/a.ts" }] }))?.files[0]?.purpose,
  "no stated purpose",
);
check(
  "entries with no usable path are skipped",
  parsePlan(JSON.stringify({
    summary: "x",
    files: [{ path: "" }, { purpose: "orphan" }, "a string", { path: "src/a.ts", purpose: "p" }],
  }))?.files.map((f) => f.path),
  ["src/a.ts"],
);
check(
  "a runaway plan is truncated to 25 files",
  parsePlan(JSON.stringify({
    summary: "x",
    files: Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, purpose: "p" })),
  }))?.files.length,
  25,
);
check(
  "a missing summary gets a stated placeholder",
  parsePlan(JSON.stringify({ files: [{ path: "src/a.ts", purpose: "p" }] }))?.summary,
  "no summary given",
);
check(
  "a non-array outOfScope is ignored rather than crashing",
  parsePlan(JSON.stringify({
    summary: "x", files: [{ path: "src/a.ts", purpose: "p" }], outOfScope: "nope",
  }))?.outOfScope,
  undefined,
);

// ── formatPlanForPrompt ───────────────────────────────────────────────────────

const block = formatPlanForPrompt({
  summary: "A client tracker.",
  files: [
    { path: "src/types.ts", purpose: "shared types" },
    { path: "src/views/Dashboard.tsx", purpose: "KPI cards" },
  ],
  outOfScope: ["email notifications"],
});
check("the block numbers the files in order", /1\. src\/types\.ts — shared types/.test(block), true);
check("the block lists every file", /2\. src\/views\/Dashboard\.tsx/.test(block), true);
check("out-of-scope items are told not to be built", /Do not build these/.test(block), true);
// The planner saw only the prompt; the builder can see the running app. A plan
// presented as binding would make the model follow it past learning better.
check("the plan is presented as a starting point, not a contract", /not a contract/.test(block), true);
check("the one-file habit is still ruled out", /one large file/.test(block), true);

const noScope = formatPlanForPrompt({ summary: "s", files: [{ path: "src/a.ts", purpose: "p" }] });
check("no out-of-scope section when there is nothing to exclude", /Do not build these/.test(noScope), false);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
