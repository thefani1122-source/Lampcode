export type Checkpoint = {
  label: string;
  at: number;
  files: Record<string, string>;
};

export const MAX_CHECKPOINTS = 5;

export type CheckpointPathState = {
  generatedPresent: boolean;
  generatedContent?: string;
  tombstoned: boolean;
};

/** Capture the exact in-memory representation of one path for revert rollback. */
export function snapshotCheckpointPathState(
  path: string,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: ReadonlySet<string> | undefined,
): CheckpointPathState {
  const generatedPresent = Object.hasOwn(generatedFiles ?? {}, path);
  return {
    generatedPresent,
    ...(generatedPresent ? { generatedContent: generatedFiles![path]! } : {}),
    tombstoned: deletedFiles?.has(path) ?? false,
  };
}

/** Restore a captured path shape without touching the immutable baseline. */
export function restoreCheckpointPathState(
  path: string,
  state: CheckpointPathState,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: Set<string> | undefined,
): void {
  if (generatedFiles) {
    if (state.generatedPresent) generatedFiles[path] = state.generatedContent!;
    else delete generatedFiles[path];
  }
  if (deletedFiles) {
    if (state.tombstoned) deletedFiles.add(path);
    else deletedFiles.delete(path);
  }
}

/** Copy the project map so later tool writes cannot mutate an earlier checkpoint. */
export function takeCheckpoint(
  label: string,
  files: Record<string, string>,
): Checkpoint {
  return { label, at: Date.now(), files: { ...files } };
}

/** Add a snapshot as newest, replacing a matching label and evicting the oldest if full. */
export function storeCheckpoint(
  checkpoints: Map<string, Checkpoint>,
  checkpoint: Checkpoint,
): { replaced: boolean; evicted?: string } {
  const replaced = checkpoints.has(checkpoint.label);
  if (replaced) checkpoints.delete(checkpoint.label);

  let evicted: string | undefined;
  if (!replaced && checkpoints.size >= MAX_CHECKPOINTS) {
    evicted = checkpoints.keys().next().value;
    if (evicted !== undefined) checkpoints.delete(evicted);
  }

  checkpoints.set(checkpoint.label, checkpoint);
  return { replaced, ...(evicted === undefined ? {} : { evicted }) };
}

/** Compare two exact project maps. Sorted paths keep tool output deterministic. */
export function restorePlan(
  cp: Checkpoint,
  current: Record<string, string>,
): { toWrite: string[]; toDelete: string[]; unchanged: number } {
  const toWrite: string[] = [];
  const toDelete: string[] = [];
  let unchanged = 0;

  for (const path of Object.keys(cp.files).sort()) {
    if (current[path] === cp.files[path]) unchanged++;
    else toWrite.push(path);
  }
  for (const path of Object.keys(current).sort()) {
    if (!Object.hasOwn(cp.files, path)) toDelete.push(path);
  }

  return { toWrite, toDelete, unchanged };
}

export function formatRestorePlan(
  plan: ReturnType<typeof restorePlan>,
): string {
  const changes = plan.toWrite.length + plan.toDelete.length;
  if (changes === 0) return `Already at checkpoint (${plan.unchanged} unchanged file(s)).`;
  return (
    `Restore plan: ${plan.toWrite.length} file(s) to restore, ` +
    `${plan.toDelete.length} file(s) to remove, ${plan.unchanged} unchanged.`
  );
}

export function formatUnknownCheckpoint(label: string, labels: string[]): string {
  if (labels.length === 0) return `No checkpoint named "${label}" exists; there are no saved checkpoints.`;
  return `No checkpoint named "${label}" exists. Available checkpoints: ${labels.join(", ")}.`;
}

/** Reconcile a restore against the immutable build-start baseline using per-path tombstones. */
export function applyCheckpointToState(
  checkpointFiles: Record<string, string>,
  projectFiles: Record<string, string> | undefined,
  generatedFiles: Record<string, string>,
  deletedFiles: Set<string>,
  plan: ReturnType<typeof restorePlan>,
): void {
  const baseline = projectFiles ?? {};

  for (const path of plan.toWrite) {
    const content = checkpointFiles[path]!;
    deletedFiles.delete(path);
    if (Object.hasOwn(baseline, path) && baseline[path] === content) {
      delete generatedFiles[path];
    } else {
      generatedFiles[path] = content;
    }
  }

  for (const path of plan.toDelete) {
    delete generatedFiles[path];
    if (Object.hasOwn(baseline, path)) deletedFiles.add(path);
    else deletedFiles.delete(path);
  }
}

