/**
 * A unified diff between two versions of one file, for display only.
 *
 * This exists so the chat can show WHAT an edit changed instead of only that
 * an edit happened. It is deliberately computed from the file as it was and
 * the file as it now is — not from the model's `old_string`/`new_string`
 * arguments. Those are what the model ASKED for; a tool can refuse, clamp or
 * partially apply a request, and showing the ask as though it were the outcome
 * is exactly the kind of confident-but-wrong report this codebase keeps
 * getting bitten by.
 */

/** Lines of one contiguous changed region, with context either side. */
export interface DiffHunk {
  /** 1-based first line of the hunk in the OLD file. */
  oldStart: number;
  /** 1-based first line of the hunk in the NEW file. */
  newStart: number;
  lines: Array<{ sign: " " | "+" | "-"; text: string }>;
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Hunks were dropped or cut short; `added`/`removed` are still exact. */
  truncated: boolean;
}

// An LCS table is width × height cells, so it has to be bounded or one
// generated 20k-line file pins the event loop. Past the cap the counts are
// still reported — only the line-by-line view is given up.
const MAX_LCS_CELLS = 250_000;
const CONTEXT = 3;
const MAX_DIFF_LINES = 160;
const MAX_DIFF_BYTES = 12_000;

type Op = { sign: " " | "+" | "-"; text: string };

/** Longest-common-subsequence edit script over two line arrays. */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);

  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = a[i] ?? "";
    const right = b[j] ?? "";
    if (left === right) {
      ops.push({ sign: " ", text: left });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ sign: "-", text: left });
      i++;
    } else {
      ops.push({ sign: "+", text: right });
      j++;
    }
  }
  while (i < n) ops.push({ sign: "-", text: a[i++] ?? "" });
  while (j < m) ops.push({ sign: "+", text: b[j++] ?? "" });
  return ops;
}

/**
 * Null when nothing changed, so a caller can treat "no diff" and "no change"
 * as the same thing and never render an empty panel.
 */
export function diffFile(path: string, before: string, after: string): FileDiff | null {
  if (before === after) return null;

  const a = before.split("\n");
  const b = after.split("\n");

  // Trim the identical head and tail first. A localized edit in a large file
  // leaves a middle small enough to diff properly, which is the common case.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  if (aMid.length === 0 && bMid.length === 0) return null;

  if (aMid.length * bMid.length > MAX_LCS_CELLS) {
    return { path, added: bMid.length, removed: aMid.length, hunks: [], truncated: true };
  }

  const ops =
    aMid.length === 0
      ? bMid.map((text): Op => ({ sign: "+", text }))
      : bMid.length === 0
        ? aMid.map((text): Op => ({ sign: "-", text }))
        : editScript(aMid, bMid);

  const added = ops.reduce((n, op) => n + (op.sign === "+" ? 1 : 0), 0);
  const removed = ops.reduce((n, op) => n + (op.sign === "-" ? 1 : 0), 0);

  // Group the changed ops into hunks, padding each with context. Context lines
  // are identical in both files, so they can be read off `a` by index.
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.sign !== " ") changed.push(index);
  });

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last && index - last[1] <= CONTEXT * 2) last[1] = index;
    else ranges.push([index, index]);
  }

  const hunks: DiffHunk[] = [];
  let emitted = 0;
  let bytes = 0;
  let truncated = false;

  for (const [from, to] of ranges) {
    if (truncated) break;

    // Walk the ops once to learn where this range sits in each file.
    let oldLine = head;
    let newLine = head;
    for (let k = 0; k < from; k++) {
      const sign = ops[k]?.sign;
      if (sign !== "+") oldLine++;
      if (sign !== "-") newLine++;
    }

    const lines: DiffHunk["lines"] = [];
    const leading = Math.min(CONTEXT, oldLine - 0, newLine - 0);
    for (let k = leading; k > 0; k--) {
      lines.push({ sign: " ", text: a[oldLine - k] ?? "" });
    }

    for (let k = from; k <= to; k++) {
      if (emitted + lines.length >= MAX_DIFF_LINES || bytes > MAX_DIFF_BYTES) {
        truncated = true;
        break;
      }
      const op = ops[k];
      if (!op) break;
      lines.push(op);
      bytes += op.text.length + 1;
    }

    const afterIndex = oldLine + ops.slice(from, to + 1).filter((op) => op.sign !== "+").length;
    for (let k = 0; k < CONTEXT; k++) {
      const text = a[afterIndex + k];
      if (text === undefined) break;
      lines.push({ sign: " ", text });
    }

    hunks.push({
      oldStart: Math.max(1, oldLine - leading + 1),
      newStart: Math.max(1, newLine - leading + 1),
      lines,
    });
    emitted += lines.length;
  }

  return { path, added, removed, hunks, truncated };
}
