import {
  applyCheckpointToState,
  formatRestorePlan,
  formatUnknownCheckpoint,
  storeCheckpoint,
  takeCheckpoint,
  restorePlan,
  restoreCheckpointPathState,
  snapshotCheckpointPathState,
  type Checkpoint,
} from "../src/verify/checkpoints.js";

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

const source = { "src/a.ts": "v1" };
const snapshot = takeCheckpoint("before", source);
source["src/a.ts"] = "v2";
check("snapshot copies file contents by value", snapshot.files, { "src/a.ts": "v1" });

check(
  "changed and deleted checkpoint files are restored and later files are removed",
  restorePlan(snapshot, { "src/a.ts": "v2", "src/new.ts": "new" }),
  { toWrite: ["src/a.ts"], toDelete: ["src/new.ts"], unchanged: 0 },
);
check(
  "unchanged files are counted and not rewritten",
  restorePlan(takeCheckpoint("same", { "src/a.ts": "v1" }), { "src/a.ts": "v1" }),
  { toWrite: [], toDelete: [], unchanged: 1 },
);
check(
  "empty projects can be checkpointed and restored",
  restorePlan(takeCheckpoint("empty", {}), {}),
  { toWrite: [], toDelete: [], unchanged: 0 },
);
check(
  "restore plan formatting is plain and notes unchanged files",
  formatRestorePlan({ toWrite: ["a"], toDelete: ["b"], unchanged: 3 }),
  "Restore plan: 1 file(s) to restore, 1 file(s) to remove, 3 unchanged.",
);

const checkpoints = new Map<string, Checkpoint>();
storeCheckpoint(checkpoints, takeCheckpoint("a", { a: "1" }));
storeCheckpoint(checkpoints, takeCheckpoint("b", { b: "1" }));
storeCheckpoint(checkpoints, takeCheckpoint("c", { c: "1" }));
storeCheckpoint(checkpoints, takeCheckpoint("d", { d: "1" }));
storeCheckpoint(checkpoints, takeCheckpoint("e", { e: "1" }));
check("same-label replacement reports replacement", storeCheckpoint(checkpoints, takeCheckpoint("b", { b: "2" })), { replaced: true });
check("same-label replacement moves the label to newest position", [...checkpoints.keys()], ["a", "c", "d", "e", "b"]);
check("sixth distinct checkpoint evicts the oldest", storeCheckpoint(checkpoints, takeCheckpoint("f", { f: "1" })), { replaced: false, evicted: "a" });
check("unknown label lists available checkpoint labels", formatUnknownCheckpoint("missing", ["c", "e"]), "No checkpoint named \"missing\" exists. Available checkpoints: c, e.");
check("unknown label with no saved checkpoints says none exist", formatUnknownCheckpoint("missing", []), "No checkpoint named \"missing\" exists; there are no saved checkpoints.");

const baseline = { "src/base.ts": "baseline v1" };
const baselineCopy = { ...baseline };
const generated: Record<string, string> = {};
const deleted = new Set(["src/base.ts"]);
applyCheckpointToState(
  { "src/base.ts": "baseline v1" },
  baseline,
  generated,
  deleted,
  { toWrite: ["src/base.ts"], toDelete: [], unchanged: 0 },
);
check(
  "restoring a tombstoned baseline file clears its tombstone and uses the baseline",
  { generated, deleted: [...deleted], current: { ...baseline, ...generated } },
  { generated: {}, deleted: [], current: { "src/base.ts": "baseline v1" } },
);

const baselineWithOverride = { "src/base.ts": "baseline v1" };
const generatedWithOverride = { "src/base.ts": "checkpoint v2", "src/new.ts": "new" };
const tombstones = new Set<string>();
const checkpointFiles = { "src/base.ts": "checkpoint v2" };
const baselineCheckpoint = takeCheckpoint("baseline", checkpointFiles);
const deletePlan = restorePlan(baselineCheckpoint, { ...baselineWithOverride, ...generatedWithOverride });
applyCheckpointToState(checkpointFiles, baselineWithOverride, generatedWithOverride, tombstones, deletePlan);
check(
  "restore removes post-checkpoint files and preserves the baseline",
  {
    baseline: baselineWithOverride,
    generated: generatedWithOverride,
    deleted: [...tombstones],
    current: { ...baselineWithOverride, ...generatedWithOverride },
  },
  {
    baseline: { "src/base.ts": "baseline v1" },
    generated: { "src/base.ts": "checkpoint v2" },
    deleted: [],
    current: { "src/base.ts": "checkpoint v2" },
  },
);
check("the build-start baseline remains unchanged", baseline, baselineCopy);

const recreatedBaseline = { "src/a.ts": "baseline" };
const recreatedGenerated: Record<string, string> = {};
const recreatedDeleted = new Set<string>();
applyCheckpointToState(
  {},
  recreatedBaseline,
  recreatedGenerated,
  recreatedDeleted,
  { toWrite: [], toDelete: ["src/a.ts"], unchanged: 0 },
);
check(
  "revert removes a baseline file deleted after an empty checkpoint",
  { generated: recreatedGenerated, deleted: [...recreatedDeleted], baseline: recreatedBaseline },
  { generated: {}, deleted: ["src/a.ts"], baseline: { "src/a.ts": "baseline" } },
);

ok("a checkpoint remains in the map after restore planning", checkpoints.has("b"));
const rollbackGenerated: Record<string, string> = { "src/override.ts": "before" };
const rollbackDeleted = new Set(["src/tombstone.ts"]);
const overrideSnapshot = snapshotCheckpointPathState("src/override.ts", rollbackGenerated, rollbackDeleted);
const baselineSnapshot = snapshotCheckpointPathState("src/base.ts", rollbackGenerated, rollbackDeleted);
const tombstoneSnapshot = snapshotCheckpointPathState("src/tombstone.ts", rollbackGenerated, rollbackDeleted);
delete rollbackGenerated["src/override.ts"];
rollbackGenerated["src/base.ts"] = "temporary";
rollbackDeleted.delete("src/tombstone.ts");
rollbackDeleted.add("src/base.ts");
restoreCheckpointPathState("src/override.ts", overrideSnapshot, rollbackGenerated, rollbackDeleted);
restoreCheckpointPathState("src/base.ts", baselineSnapshot, rollbackGenerated, rollbackDeleted);
restoreCheckpointPathState("src/tombstone.ts", tombstoneSnapshot, rollbackGenerated, rollbackDeleted);
check(
  "rollback restores exact generated-file presence and tombstone state",
  { generated: rollbackGenerated, deleted: [...rollbackDeleted].sort() },
  { generated: { "src/override.ts": "before" }, deleted: ["src/tombstone.ts"] },
);
console.log(failures === 0 ? "\nAll checkpoint cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);

