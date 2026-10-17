import { unifiedDiff } from "../src/verify/diff.js";
import { currentProjectFiles } from "../src/agents/file-deletion.js";

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

const changed = unifiedDiff({ "src/a.ts": "one\ntwo\n" }, { "src/a.ts": "one\nTWO\n" });
ok("single-line edit has unified headers and replacement lines", changed.text.includes("--- a/src/a.ts\n+++ b/src/a.ts\n") && changed.text.includes("-two\n+TWO\n"));
check("single-line counts are exact", [changed.filesChanged, changed.added, changed.removed], [1, 1, 1]);

const manyHunks = unifiedDiff(
  { "src/a.ts": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n" },
  { "src/a.ts": "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\n" },
  { context: 1 },
);
check("separated edits produce multiple hunks", (manyHunks.text.match(/^@@ /gm) ?? []).length, 2);

const created = unifiedDiff({}, { "new.ts": "a\nb\n" });
ok("new file is all-added", created.text.includes("--- /dev/null\n+++ b/new.ts\n") && created.text.includes("+a\n+b\n"));
const deleted = unifiedDiff({ "old.ts": "a\nb\n" }, {});
ok("deleted file is all-removed", deleted.text.includes("--- a/old.ts\n+++ /dev/null\n") && deleted.text.includes("-a\n-b\n"));

const multi = unifiedDiff({ z: "z\n", a: "a\n" }, { z: "Z\n", a: "A\n" });
ok("multiple files are included", multi.text.includes("a/a") && multi.text.includes("a/z"));
ok("paths have deterministic lexical order", multi.text.indexOf("--- a/a") < multi.text.indexOf("--- a/z"));

check("identical input says no changes", unifiedDiff({ "a.ts": "same\n" }, { "a.ts": "same\n" }), {
  text: "No changes.", filesChanged: 0, added: 0, removed: 0, truncated: false,
});
check("empty maps say no changes", unifiedDiff({}, {}), {
  text: "No changes.", filesChanged: 0, added: 0, removed: 0, truncated: false,
});
ok("empty before is represented as all additions", unifiedDiff({}, { "a.ts": "x\n" }).text.includes("+x\n"));
ok("empty after is represented as all removals", unifiedDiff({ "a.ts": "x\n" }, {}).text.includes("-x\n"));

const buildStart = { "src/keep.ts": "v1\n", "src/deleted.ts": "remove me\n" };
const currentFiles = currentProjectFiles(
  buildStart,
  { "src/keep.ts": "v2\n", "src/new.ts": "created\n" },
  new Set(["src/deleted.ts"]),
);
const stateDiff = unifiedDiff(buildStart, currentFiles);
ok("tombstoned baseline files appear as deletions alongside edits and new files",
  stateDiff.text.includes("--- a/src/deleted.ts\n+++ /dev/null\n") &&
  stateDiff.text.includes("--- /dev/null\n+++ b/src/new.ts\n") &&
  stateDiff.filesChanged === 3);

const checkpointDiff = unifiedDiff(
  { "src/page.tsx": "checkpoint-v2\n" },
  { "src/page.tsx": "current-v3\n" },
);
ok("checkpoint comparisons start from the named snapshot contents", 
  checkpointDiff.text.includes("-checkpoint-v2\n+current-v3\n") && !checkpointDiff.text.includes("v1"));

const edges = unifiedDiff({ "a.ts": "old\nkeep\nlast\n" }, { "a.ts": "new\nkeep\nlast\n" }, { context: 3 });
ok("context includes lines at the beginning and end", edges.text.includes("+new\n") && edges.text.includes(" last\n"));
const noContext = unifiedDiff({ "a.ts": "old\nkeep\n" }, { "a.ts": "new\nkeep\n" }, { context: 0 });
ok("context zero emits no surrounding lines", !noContext.text.includes(" keep\n"));

const noFinalNewline = unifiedDiff({ "a.ts": "old" }, { "a.ts": "new" });
ok("EOF without newline is explicit on both sides", (noFinalNewline.text.match(/\\ No newline at end of file/g) ?? []).length === 2);

check("added and removed line totals are counted", [
  unifiedDiff({ "a.ts": "a\nb\n" }, { "a.ts": "a\nc\nd\n" }).added,
  unifiedDiff({ "a.ts": "a\nb\n" }, { "a.ts": "a\nc\nd\n" }).removed,
], [2, 1]);

const outputLimited = unifiedDiff(
  { "a.ts": "old\n", "b.ts": `${"x".repeat(300)}\n` },
  { "a.ts": "new\n", "b.ts": `${"y".repeat(300)}\n` },
  { maxChars: 900 },
);
ok("character truncation is reported while exact counts remain", outputLimited.truncated &&
  outputLimited.text.includes("counts above still include every computed file") &&
  outputLimited.filesChanged === 2 && outputLimited.added === 2 && outputLimited.removed === 2);
ok("character cap keeps complete hunks and omits the oversized file block", 
  (outputLimited.text.match(/^@@ /gm) ?? []).length === 1 &&
  outputLimited.text.includes("-old\n+new\n"));

const computationLimited = unifiedDiff(
  { "large.ts": Array.from({ length: 9000 }, (_, i) => `before-${i}`).join("\n") },
  { "large.ts": Array.from({ length: 9000 }, (_, i) => `after-${i}`).join("\n") },
);
ok("safety truncation warns counts are partial", computationLimited.truncated &&
  computationLimited.text.includes("Diff truncated during computation") &&
  computationLimited.text.includes("not complete project totals"));
check("omitted computation does not manufacture all-added/all-removed counts", [computationLimited.added, computationLimited.removed], [0, 0]);

if (failures > 0) {
  console.error(`\n${failures} diff test(s) failed.`);
  process.exit(1);
}
console.log("\nAll diff tests passed.");

