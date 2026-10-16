import {
  commitFileDeletion,
  currentProjectFiles,
  planFileDeletions,
} from "../src/agents/file-deletion.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
    return;
  }
  failures++;
  console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
}
function ok(name: string, condition: boolean): void {
  check(name, condition, true);
}

const isTemplateOwned = (path: string) => path === "src/styles.css";

check(
  "template-owned paths are refused and named",
  planFileDeletions(["src/styles.css"], { "src/styles.css": "template" }, isTemplateOwned),
  [{ path: "src/styles.css", status: "template-owned" }],
);
check(
  "the active and framework entry points are refused and named",
  planFileDeletions(
    ["src/App.tsx", "app/page.tsx", "app/routes/index.tsx"],
    { "src/App.tsx": "react", "app/page.tsx": "next", "app/routes/index.tsx": "tanstack" },
    isTemplateOwned,
  ).map(({ path, status }) => [path, status]),
  [
    ["src/App.tsx", "entry-point"],
    ["app/page.tsx", "entry-point"],
    ["app/routes/index.tsx", "entry-point"],
  ],
);

check(
  "a missing path is reported as already absent, not thrown",
  (() => {
    try {
      return planFileDeletions(["src/missing.ts"], {}, isTemplateOwned)[0]?.status;
    } catch {
      return "threw";
    }
  })(),
  "missing",
);

const baseline = { "src/old.ts": "old source", "src/App.tsx": "entry" };
const generated = { "src/old.ts": "newer source" };
const deleted = new Set<string>();
const decision = planFileDeletions(
  ["src/old.ts"],
  currentProjectFiles(baseline, generated, deleted),
  isTemplateOwned,
)[0]!;
const measurements: unknown[][] = [];
commitFileDeletion(
  decision.path,
  decision.before ?? "",
  generated,
  deleted,
  (before, after, kind) => measurements.push([before, after, kind]),
  () => measurements.push(["noteWrite"]),
);
check(
  "successful deletion removes the current path without destroying the baseline",
  {
    baseline: baseline["src/old.ts"],
    generatedOwnsPath: Object.hasOwn(generated, "src/old.ts"),
    tombstoned: deleted.has("src/old.ts"),
    current: currentProjectFiles(baseline, generated, deleted),
  },
  {
    baseline: "old source",
    generatedOwnsPath: false,
    tombstoned: true,
    current: { "src/App.tsx": "entry" },
  },
);
check(
  "a successful deletion records removed lines and marks the build write",
  measurements,
  [["newer source", "", "deleted"], ["noteWrite"]],
);
check(
  "a tombstone prevents both baseline and generated merges from restoring a deleted path",
  currentProjectFiles(
    { "src/old.ts": "baseline" },
    { "src/old.ts": "generated" },
    new Set(["src/old.ts"]),
  ),
  {},
);

const mixed = planFileDeletions(
  ["src/free.ts", "src/styles.css", "src/App.tsx", "missing.ts"],
  { "src/free.ts": "remove me", "src/styles.css": "template", "src/App.tsx": "entry" },
  isTemplateOwned,
);
check(
  "a mixed batch reports successful, refused, and missing paths separately",
  mixed.map(({ path, status }) => [path, status]),
  [
    ["src/free.ts", "ready"],
    ["src/styles.css", "template-owned"],
    ["src/App.tsx", "entry-point"],
    ["missing.ts", "missing"],
  ],
);

const allFiles = { "src/App.tsx": "entry", "src/feature.ts": "feature" };
const removePlan = planFileDeletions(Object.keys(allFiles), allFiles, isTemplateOwned);
const allGenerated = { ...allFiles };
const allDeleted = new Set<string>();
for (const item of removePlan) {
  if (item.status === "ready") {
    commitFileDeletion(item.path, item.before ?? "", allGenerated, allDeleted, () => {}, () => {});
  }
}
check(
  "deleting every requested path still leaves the entry point",
  Object.keys(currentProjectFiles(allFiles, allGenerated, allDeleted)),
  ["src/App.tsx"],
);

check(
  "unsafe paths are refused before any file lookup",
  planFileDeletions(["../secrets"], {}, isTemplateOwned)[0]?.status,
  "unsafe-path",
);

console.log(failures === 0 ? "\nAll delete-file cases passed." : "\n" + failures + " case(s) failed.");
if (failures > 0) process.exit(1);

