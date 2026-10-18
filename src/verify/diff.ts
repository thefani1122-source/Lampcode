export type UnifiedDiffResult = {
  text: string;
  filesChanged: number;
  added: number;
  removed: number;
  truncated: boolean;
};

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_CHARS = 12_000;
const HARD_MAX_CHARS = 24_000;
const MAX_FILE_CHARS = 1_000_000;
const MAX_FILE_LINES = 12_000;
const MAX_FILE_WORK = 350_000;
const MAX_TOTAL_WORK = 1_200_000;

type Line = { text: string; newline: boolean };
type Op = { kind: "equal" | "add" | "remove"; line: Line };
type DiffFile = { path: string; block: string; added: number; removed: number; hunks: number };

function splitLines(value: string): Line[] {
  if (value === "") return [];
  const parts = value.split("\n");
  const endsWithNewline = value.endsWith("\n");
  if (endsWithNewline) parts.pop();
  return parts.map((text, index) => ({
    text,
    newline: index < parts.length - 1 || endsWithNewline,
  }));
}

function sameLine(a: Line, b: Line): boolean {
  return a.text === b.text && a.newline === b.newline;
}

/** Bounded Myers diff. `undefined` means its work budget was exhausted. */
function myers(before: Line[], after: Line[], budget: { left: number }): Op[] | undefined {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(max * 2 + 3);
  const trace: Int32Array[] = [];
  let finishedAt = -1;

  for (let d = 0; d <= max; d++) {
    if (budget.left < 1) return undefined;
    budget.left--;
    for (let k = -d; k <= d; k += 2) {
      if (budget.left < 1) return undefined;
      budget.left--;
      const index = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[index - 1]! < v[index + 1]!)) {
        x = v[index + 1]!;
      } else {
        x = v[index - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && sameLine(before[x]!, after[y]!)) {
        if (budget.left < 1) return undefined;
        budget.left--;
        x++;
        y++;
      }
      v[index] = x;
      if (x >= n && y >= m) {
        finishedAt = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (finishedAt >= 0) break;
  }

  if (finishedAt < 0) return undefined;
  const get = (row: Int32Array, depth: number, k: number): number => row[k + depth]!;
  const reversed: Op[] = [];
  let x = n;
  let y = m;

  for (let d = finishedAt; d > 0; d--) {
    const previous = trace[d - 1]!;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && get(previous, d - 1, k - 1) < get(previous, d - 1, k + 1))
        ? k + 1
        : k - 1;
    const previousX = get(previous, d - 1, previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: "equal", line: before[--x]! });
      y--;
    }
    if (x === previousX) reversed.push({ kind: "add", line: after[--y]! });
    else reversed.push({ kind: "remove", line: before[--x]! });
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "equal", line: before[--x]! });
    y--;
  }
  while (x > 0) reversed.push({ kind: "remove", line: before[--x]! });
  while (y > 0) reversed.push({ kind: "add", line: after[--y]! });
  return reversed.reverse();
}

function rangeStart(index: number, count: number): number {
  return count === 0 ? index : index + 1;
}

function safePath(path: string): string {
  return path.replace(/[\r\n\0]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function renderLine(prefix: string, line: Line): string {
  return `${prefix}${line.text}\n${line.newline ? "" : "\\ No newline at end of file\n"}`;
}

function renderFile(
  path: string,
  beforePresent: boolean,
  afterPresent: boolean,
  ops: Op[],
  context: number,
): DiffFile {
  let added = 0;
  let removed = 0;
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "add") {
      added++;
      changes.push(i);
    } else if (op.kind === "remove") {
      removed++;
      changes.push(i);
    }
  }

  const groups: Array<[number, number]> = [];
  for (const index of changes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] - 1 <= context * 2) last[1] = index;
    else groups.push([index, index]);
  }

  let block = `--- ${beforePresent ? `a/${safePath(path)}` : "/dev/null"}\n` +
    `+++ ${afterPresent ? `b/${safePath(path)}` : "/dev/null"}\n`;
  if (groups.length === 0) return { path, block, added, removed, hunks: 0 };

  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    let oldIndex = 0;
    let newIndex = 0;
    for (let i = 0; i < start; i++) {
      if (ops[i]!.kind !== "add") oldIndex++;
      if (ops[i]!.kind !== "remove") newIndex++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i < end; i++) {
      if (ops[i]!.kind !== "add") oldCount++;
      if (ops[i]!.kind !== "remove") newCount++;
    }
    block += `@@ -${rangeStart(oldIndex, oldCount)},${oldCount} +${rangeStart(newIndex, newCount)},${newCount} @@\n`;
    for (let i = start; i < end; i++) {
      const op = ops[i]!;
      const prefix = op.kind === "equal" ? " " : op.kind === "add" ? "+" : "-";
      block += renderLine(prefix, op.line);
    }
  }
  return { path, block, added, removed, hunks: groups.length };
}

/**
 * Produce a deterministic unified diff. Computation limits omit whole files and
 * mark counts as partial; output limits omit whole file blocks while retaining
 * exact counts for every file whose diff was computed.
 */
export function unifiedDiff(
  before: Record<string, string>,
  after: Record<string, string>,
  opts?: { context?: number; maxChars?: number },
): { text: string; filesChanged: number; added: number; removed: number; truncated: boolean } {
  const context = Number.isFinite(opts?.context)
    ? Math.max(0, Math.min(20, Math.floor(opts!.context!)))
    : DEFAULT_CONTEXT;
  const maxChars = Number.isFinite(opts?.maxChars)
    ? Math.max(512, Math.min(HARD_MAX_CHARS, Math.floor(opts!.maxChars!)))
    : DEFAULT_MAX_CHARS;
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changedPaths = paths.filter((path) =>
    Object.hasOwn(before, path) !== Object.hasOwn(after, path) || before[path] !== after[path],
  );
  if (changedPaths.length === 0) {
    return { text: "No changes.", filesChanged: 0, added: 0, removed: 0, truncated: false };
  }

  const blocks: string[] = [];
  let filesChanged = 0;
  let added = 0;
  let removed = 0;
  let computeOmitted = 0;
  let outputOmitted = 0;
  let outputOmittedHunks = 0;
  let workLeft = MAX_TOTAL_WORK;
  const blockBudget = maxChars - 350;
  let blockChars = 0;

  for (const path of changedPaths) {
    const beforePresent = Object.hasOwn(before, path);
    const afterPresent = Object.hasOwn(after, path);
    const oldText = beforePresent ? before[path]! : "";
    const newText = afterPresent ? after[path]! : "";
    const tooLarge = oldText.length > MAX_FILE_CHARS || newText.length > MAX_FILE_CHARS;
    const oldLines = tooLarge ? [] : splitLines(oldText);
    const newLines = tooLarge ? [] : splitLines(newText);
    if (tooLarge || oldLines.length > MAX_FILE_LINES || newLines.length > MAX_FILE_LINES) {
      computeOmitted++;
      continue;
    }

    // A missing side has only one possible edit script. Searching it would spend
    // the shared budget needed to find meaningful edits in later files.
    let ops: Op[] | undefined;
    if (!beforePresent) {
      ops = newLines.map((line) => ({ kind: "add", line }));
    } else if (!afterPresent) {
      ops = oldLines.map((line) => ({ kind: "remove", line }));
    } else {
      const remaining = { left: Math.min(MAX_FILE_WORK, workLeft) };
      ops = myers(oldLines, newLines, remaining);
      const spent = Math.min(MAX_FILE_WORK, workLeft) - remaining.left;
      workLeft -= spent;
    }
    if (!ops) {
      computeOmitted++;
      continue;
    }

    const file = renderFile(path, beforePresent, afterPresent, ops, context);
    filesChanged++;
    added += file.added;
    removed += file.removed;
    const separatorLength = blocks.length > 0 ? 1 : 0;
    if (blockChars + separatorLength + file.block.length <= blockBudget) {
      blocks.push(file.block);
      blockChars += separatorLength + file.block.length;
    } else {
      outputOmitted++;
      outputOmittedHunks += file.hunks;
    }
  }

  const truncated = computeOmitted > 0 || outputOmitted > 0;
  const diffText = blocks.length > 0
    ? blocks.join("\n")
    : computeOmitted > 0
      ? "No complete file diff was available within the computation safety limits."
      : "No complete file diff fit within the output limit.";
  const summary = computeOmitted > 0
    ? `Diff truncated during computation. Computed portion: ${filesChanged} file(s) changed, +${added} / -${removed} lines. ` +
      `${computeOmitted} changed file(s) were omitted because of safety limits; these counts are not complete project totals.`
    : `${filesChanged} file(s) changed, +${added} / -${removed} lines.`;
  const outputNote = outputOmitted > 0
    ? `Output truncated: ${outputOmitted} complete file diff(s), containing ${outputOmittedHunks} complete hunk(s), were omitted; counts above still include every computed file.`
    : "";
  const text = [diffText, summary, outputNote].filter(Boolean).join("\n\n");
  return { text, filesChanged, added, removed, truncated };
}

