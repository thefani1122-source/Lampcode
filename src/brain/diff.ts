// ── Line diff types ───────────────────────────────────────────────────────────

export interface DiffLine {
  type: "equal" | "added" | "removed";
  content: string;
}

// ── LCS-based line diff ───────────────────────────────────────────────────────

/**
 * Compute a line-level diff between two strings using the Longest Common
 * Subsequence algorithm. Returns a sequence of equal/added/removed lines
 * that transforms `a` into `b`.
 */
export function lcsLineDiff(a: string, b: string): DiffLine[] {
  const aLines = a === "" ? [] : a.split("\n");
  const bLines = b === "" ? [] : b.split("\n");
  const m = aLines.length;
  const n = bLines.length;

  // Build LCS length table O(m × n)
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        aLines[i - 1] === bLines[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Backtrack to produce the diff sequence
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      result.unshift({ type: "equal", content: aLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ type: "added", content: bLines[j - 1]! });
      j--;
    } else {
      result.unshift({ type: "removed", content: aLines[i - 1]! });
      i--;
    }
  }
  return result;
}
