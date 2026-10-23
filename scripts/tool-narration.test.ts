/**
 * The two halves of making a build readable: words for each tool call, and a
 * diff that reports what was APPLIED.
 *
 * The drift guard at the bottom is the important one. Tool names live in
 * registry.ts and their phrasing lives in tool-narration.ts, which is exactly
 * the two-places-must-agree shape that CLAUDE.md calls the #1 bug class here.
 * A tool added without a phrase would quietly show the user "Ran find wiring
 * gaps" — readable, but not the sentence that sells the product.
 */

import { readFileSync } from "node:fs";
import { diffFile } from "../src/agents/file-diff.js";
import { narrateTool, formatLineDelta } from "../src/agents/tool-narration.js";

let failures = 0;
let checks = 0;
function ok(name: string, pass: boolean, detail?: string): void {
  checks++;
  if (pass) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

// ── diffFile ────────────────────────────────────────────────────────────────

eq("an unchanged file produces no diff", diffFile("a.ts", "one\ntwo", "one\ntwo"), null);

{
  const diff = diffFile("a.ts", "one\ntwo\nthree", "one\nTWO\nthree");
  eq("a one-line change counts one added and one removed", [diff?.added, diff?.removed], [1, 1]);
  eq("it produces a single hunk", diff?.hunks.length, 1);
  const signs = diff?.hunks[0]?.lines.map((l) => l.sign).join("") ?? "";
  ok("the changed lines carry context either side", signs.includes("-+") && signs.startsWith(" "), signs);
  eq("the hunk starts at the first context line", diff?.hunks[0]?.oldStart, 1);
}

{
  const diff = diffFile("a.ts", "one\ntwo", "one\nmiddle\ntwo");
  eq("a pure insertion removes nothing", [diff?.added, diff?.removed], [1, 0]);
}

{
  const diff = diffFile("a.ts", "one\ngone\ntwo", "one\ntwo");
  eq("a pure deletion adds nothing", [diff?.added, diff?.removed], [0, 1]);
}

{
  // Two edits far enough apart that they cannot share one hunk's context.
  const before = ["a", ...Array.from({ length: 40 }, (_, i) => `line${i}`), "z"].join("\n");
  const after = before.replace("a\n", "A\n").replace("\nz", "\nZ");
  const diff = diffFile("a.ts", before, after);
  eq("two distant edits become two hunks", diff?.hunks.length, 2);
}

{
  // Past the LCS budget the counts must still be exact — only the line-by-line
  // view is given up, and the flag has to say so.
  const before = Array.from({ length: 1200 }, (_, i) => `old${i}`).join("\n");
  const after = Array.from({ length: 1200 }, (_, i) => `new${i}`).join("\n");
  const diff = diffFile("big.ts", before, after);
  eq("an oversized diff still reports exact counts", [diff?.added, diff?.removed], [1200, 1200]);
  eq("and drops the hunks", diff?.hunks.length, 0);
  eq("and admits it was truncated", diff?.truncated, true);
}

{
  const diff = diffFile("a.ts", "x\n".repeat(30) + "old", "x\n".repeat(30) + "new");
  ok("a late edit reports a line number from the real file, not the trimmed middle",
    (diff?.hunks[0]?.oldStart ?? 0) > 20, String(diff?.hunks[0]?.oldStart));
}

// ── narrateTool ─────────────────────────────────────────────────────────────

eq("an edit names the file in both tenses",
  narrateTool("edit_file", { path: "src/App.tsx" }),
  { label: "Edited src/App.tsx", active: "Editing src/App.tsx" });

eq("a multi-file write counts the files",
  narrateTool("write_files", { files: [{ path: "a" }, { path: "b" }, { path: "c" }] }).label,
  "Wrote 3 files");

eq("one file is not pluralised",
  narrateTool("write_files", { files: [{ path: "a" }] }).label,
  "Wrote 1 file");

// A replayed event carries no arguments. "Wrote 0 files" would be a lie about
// the build; saying less is the honest option.
eq("a write with no arguments does not claim zero files",
  narrateTool("write_files", undefined).label,
  "Wrote");

eq("the gates speak plainly",
  [narrateTool("check_page").label, narrateTool("check_types").label, narrateTool("find_wiring_gaps").label],
  ["Checked that the app opens", "Checked that the code compiles", "Checked every button and form"]);

ok("a long path keeps the filename visible",
  narrateTool("read_file", { path: "src/a/very/deeply/nested/directory/tree/that/keeps/going/Component.tsx" })
    .label.endsWith("Component.tsx"));

eq("a search quotes its query",
  narrateTool("search_code", { query: "useEffect" }).label,
  'Searched the code for "useEffect"');

eq("an unknown tool still reads as words",
  narrateTool("some_new_tool").label,
  "Ran some new tool");

eq("a delta uses a real minus sign", formatLineDelta(12, 3), "+12 −3");
eq("no change means no delta", formatLineDelta(0, 0), undefined);
eq("an insertion-only delta omits the minus half", formatLineDelta(4, 0), "+4");

// ── drift guard ─────────────────────────────────────────────────────────────

{
  const registry = readFileSync("src/agents/tools/registry.ts", "utf8");
  const narration = readFileSync("src/agents/tool-narration.ts", "utf8");
  const registered = [...registry.matchAll(/\[\s*"([a-z_]+)"\s*,\s*\w+Handler\s*\]/g)].map((m) => m[1] ?? "");
  ok("the registry was actually parsed", registered.length > 20, `found ${registered.length}`);
  const missing = registered.filter((name) => !new RegExp(`^\\s{2}${name}:`, "m").test(narration));
  ok("every registered tool has a phrase", missing.length === 0, `missing: ${missing.join(", ")}`);
}

console.log(`\n${checks} tool-narration checks, ${failures} failed`);
if (failures > 0) process.exit(1);
