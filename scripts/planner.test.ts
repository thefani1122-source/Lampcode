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

// EVERY agentic build plans now. Two things used to stand in the way and both
// are gone, each for a reason worth keeping:
//
//  - An EDIT never planned, on the reasoning that it already has a layout. True
//    about layout, beside the point about understanding: "add a camera so
//    people can photograph a dish and get its calories" skipped the only pass
//    that works out what a feature needs, and the agent improvised it for ten
//    minutes.
//  - A SHORT build never planned, on a word count that had been retuned twice
//    (60, then 38) and patched with three keyword lists. "build me a calorie
//    tracker" is five words and matches none of them, so the request that most
//    needed working out — who logs the calories, what is stored, is a database
//    needed at all — got nothing.
//
// The 2026-10-03 measurement that drove those patches is why they were never
// going to work: across twenty eval prompts, length CANNOT separate complexity
// (hard 41-62 words, core 38-51, smoke 29-50). A heuristic retuned twice and
// patched three times is a guess, not a threshold.
//
// So the only questions left are the two real exclusions.

const longPrompt = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");

check(
  "a new agentic build is planned",
  shouldPlan({ prompt: longPrompt, hasExistingCode: false, agenticBuild: true }),
  true,
);

check(
  "an edit is planned too — that is where the request gets understood",
  shouldPlan({ prompt: longPrompt, hasExistingCode: true, agenticBuild: true }),
  true,
);

// The two prompts that were measured failing in production, named so a future
// threshold cannot quietly exclude them again.
check(
  "the five-word first build that used to get nothing",
  shouldPlan({ prompt: "build me a calorie tracker", hasExistingCode: false, agenticBuild: true }),
  true,
);

check(
  "the one-line edit that used to get nothing",
  shouldPlan({ prompt: "add a camera", hasExistingCode: true, agenticBuild: true }),
  true,
);

check(
  "a trivial prompt plans as well — length decides nothing any more",
  shouldPlan({ prompt: "build me a counter app", hasExistingCode: false, agenticBuild: true }),
  true,
);

// The pipeline emits one shot of fenced files and never reads a plan, so
// planning for it would be paid for and thrown away. This is a real exclusion
// and must stay.
check(
  "the pipeline path is never planned",
  shouldPlan({ prompt: longPrompt, hasExistingCode: false, agenticBuild: false }),
  false,
);

check(
  "the pipeline is not planned on an edit either",
  shouldPlan({ prompt: longPrompt, hasExistingCode: true, agenticBuild: false }),
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



// ── approach: the decisions a file list cannot carry ─────────────────────────

{
  const plan = parsePlan(JSON.stringify({
    summary: "A calorie tracker.",
    approach: [
      "calories come from a built-in food table, no model call",
      "entries persist in localStorage; no database needed",
      "",
    ],
    files: [{ path: "src/App.tsx", purpose: "shell" }],
  }));
  check("approach is parsed", plan?.approach?.length, 2);
  check("and blank entries are dropped", plan?.approach?.includes(""), false);

  const text = formatPlanForPrompt(plan!);
  // Ahead of the paths on purpose: a builder that reads only the file list
  // rebuilds the shell and leaves the middle of the app empty.
  check(
    "the decisions come before the file list",
    text.indexOf("built-in food table") < text.indexOf("src/App.tsx"),
    true,
  );
  check(
    "and they are stated as decisions, not suggestions",
    text.includes("they are not suggestions"),
    true,
  );
}

check(
  "a plan with no approach still formats",
  typeof formatPlanForPrompt({ summary: "x", files: [{ path: "src/App.tsx", purpose: "shell" }] }),
  "string",
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
