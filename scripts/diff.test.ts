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

const aloneCreation = unifiedDiff({}, { "src/new.ts": "one\ntwo\n" }).text;
const creationWithOthers = unifiedDiff(
  { "zz.ts": "old\n" },
  { "src/new.ts": "one\ntwo\n", "zz.ts": "new\n" },
).text;
const aloneCreationBlock = aloneCreation.slice(0, aloneCreation.indexOf("\n\n1 file(s) changed"));
const secondFile = creationWithOthers.indexOf("\n\n--- a/zz.ts");
const sharedCreationBlock = creationWithOthers.slice(0, secondFile + 1);
check("pure-created file diff is byte-equivalent alongside another change", sharedCreationBlock, aloneCreationBlock);
check("pure-created file exact counts", [unifiedDiff({}, { "src/new.ts": "one\ntwo\n" }).added,
  unifiedDiff({}, { "src/new.ts": "one\ntwo\n" }).removed], [2, 0]);

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`).join("\n");
const fourLargeCreates: Record<string, string> = {};
for (let i = 1; i <= 4; i++) fourLargeCreates[`src/new-${i}.ts`] = lines(`created-${i}`, 11_000);
const regression = unifiedDiff(
  { "src/small.ts": "before\n" },
  { ...fourLargeCreates, "src/small.ts": "after\n" },
);
check("four 11,000-line creates do not hide the later one-line edit", [
  regression.filesChanged,
  regression.added,
  regression.removed,
  regression.text.includes("src/small.ts"),
], [5, 44_001, 1, true]);

const largeDelete = unifiedDiff(
  { "src/large-old.ts": lines("deleted", 11_000), "src/small.ts": "before\n" },
  { "src/small.ts": "after\n" },
);
check("large pure deletion does not hide a later edit and exact totals hold", [
  largeDelete.filesChanged,
  largeDelete.added,
  largeDelete.removed,
  largeDelete.text.includes("src/small.ts"),
], [2, 1, 11_001, true]);

const oversizedCreation = unifiedDiff({}, { "src/too-many-lines.ts": lines("line", 12_001) });
ok("pure create beyond the line safety limit is still omitted", oversizedCreation.truncated &&
  oversizedCreation.filesChanged === 0 && oversizedCreation.added === 0 &&
  oversizedCreation.removed === 0 && !oversizedCreation.text.includes("src/too-many-lines.ts") &&
  oversizedCreation.text.includes("omitted because of safety limits"));

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
  outputLimited.text.includes("containing 1 complete hunk(s), were omitted") &&
  outputLimited.text.includes("counts above still include every computed file") &&
  outputLimited.filesChanged === 2 && outputLimited.added === 2 && outputLimited.removed === 2);
ok("character cap keeps complete hunks and omits the oversized file block", 
  (outputLimited.text.match(/^@@ /gm) ?? []).length === 1 &&
  outputLimited.text.includes("-old\n+new\n"));

const computationLimited = unifiedDiff(
  { "a-large.ts": lines("before", 9000), "z-small.ts": "old\n" },
  { "a-large.ts": lines("after", 9000), "z-small.ts": "new\n" },
);
ok("real modification still uses bounded Myers and allows a later small edit", computationLimited.truncated &&
  computationLimited.text.includes("a-large.ts") === false && computationLimited.text.includes("z-small.ts") &&
  computationLimited.filesChanged === 1 && computationLimited.added === 1 && computationLimited.removed === 1 &&
  computationLimited.text.includes("Diff truncated during computation") &&
  computationLimited.text.includes("not complete project totals"));

if (failures > 0) {
  console.error(`\n${failures} diff test(s) failed.`);
  process.exit(1);
}
console.log("\nAll diff tests passed.");

