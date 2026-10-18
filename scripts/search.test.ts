/** Pure, in-memory code search cases. Run by npm test; no sandbox is touched. */
import { formatSearchHits, searchFiles } from "../src/verify/search.js";

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

const source = "zero\none\ntwo needle\nthree\nfour";
check(
  "literal search returns a hit and two lines of context",
  searchFiles({ "src/a.ts": source }, { query: "needle" }),
  {
    hits: [{
      path: "src/a.ts",
      line: 3,
      text: "two needle",
      before: ["zero", "one"],
      after: ["three", "four"],
    }],
    truncated: false,
    filesSearched: 1,
    filesSkipped: 0,
  },
);
check(
  "regex search is opt-in",
  searchFiles({ "src/a.ts": "const item = 1;\nlet total = 2;" }, { query: "^(const|let)\\s+\\w+", isRegex: true }).hits.map((h) => h.text),
  ["const item = 1;", "let total = 2;"],
);
check(
  "invalid regex is graceful and explains the syntax error",
  (() => {
    try {
      const result = searchFiles({ "a.ts": "x" }, { query: "[", isRegex: true });
      return [result.hits.length, result.error?.startsWith("Invalid regular expression:")];
    } catch {
      return "threw";
    }
  })(),
  [0, true],
);
check(
  "path glob includes matching files and excludes others",
  searchFiles({
    "src/cart.ts": "needle",
    "src/components/Cart.ts": "needle",
    "src/cart.tsx": "needle",
    "tests/cart.test.ts": "needle",
  }, { query: "needle", pathGlob: "src/**/*.ts" }).hits.map((h) => h.path),
  ["src/cart.ts", "src/components/Cart.ts"],
);
check(
  "single star does not cross a directory separator",
  searchFiles({
    "src/cart.ts": "needle",
    "src/components/cart.ts": "needle",
  }, { query: "needle", pathGlob: "src/*.ts" }).hits.map((h) => h.path),
  ["src/cart.ts"],
);
check(
  "a hit on the first line has no before context and no negative line numbers",
  searchFiles({ "a.ts": "needle\nsecond\nthird" }, { query: "needle" }).hits[0],
  { path: "a.ts", line: 1, text: "needle", before: [], after: ["second", "third"] },
);
check(
  "a hit on the last line has no after context or overflow",
  searchFiles({ "a.ts": "first\nsecond\nneedle" }, { query: "needle" }).hits[0],
  { path: "a.ts", line: 3, text: "needle", before: ["first", "second"], after: [] },
);
check(
  "empty query is rejected",
  searchFiles({ "a.ts": "needle" }, { query: "" }).error,
  "Search query is empty.",
);
check(
  "no matches is not an error",
  formatSearchHits(searchFiles({ "a.ts": "other" }, { query: "needle" })),
  "1 file(s) searched.\nNo matches found.",
);

const artifacts: Record<string, string> = {
  "node_modules/pkg/index.js": "needle",
  "src/dist/app.js": "needle",
  ".git/config": "needle",
  "src/oversized.ts": "needle" + "x".repeat(200 * 1024),
  "src/binary.dat": "needle\0payload",
  "src/kept.ts": "needle",
};
check(
  "vendor, build, oversized, and binary-like files are skipped and counted",
  (() => {
    const result = searchFiles(artifacts, { query: "needle" });
    return [result.hits.map((hit) => hit.path), result.filesSearched, result.filesSkipped, formatSearchHits(result).includes("5 vendor, generated, oversized, or binary file(s) skipped")];
  })(),
  [["src/kept.ts"], 1, 5, true],
);
check(
  "generated current source overrides project memory",
  (() => {
    const projectFiles = { "src/App.tsx": "old needle" };
    const generatedFiles = { "src/App.tsx": "current source" };
    const files = { ...projectFiles, ...generatedFiles };
    return searchFiles(files, { query: "needle" }).hits;
  })(),
  [],
);
check(
  "new generated source is searchable",
  searchFiles({ "src/App.tsx": "current needle" }, { query: "needle" }).hits.map((h) => h.path),
  ["src/App.tsx"],
);
check(
  "maxResults defaults to 40 and reports the omitted hits",
  (() => {
    const result = searchFiles(
      Object.fromEntries(Array.from({ length: 45 }, (_, i) => ["src/" + i + ".ts", "needle"])),
      { query: "needle" },
    );
    return [result.hits.length, result.truncated];
  })(),
  [40, true],
);
check(
  "a small maxResults value also reports truncation",
  (() => {
    const result = searchFiles({ "a.ts": "x\nx\nx" }, { query: "x", maxResults: 2 });
    return [result.hits.length, result.truncated];
  })(),
  [2, true],
);
ok(
  "formatted total output stays capped and states that it was truncated",
  (() => {
    const result = searchFiles(
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
        "src/" + i + ".ts",
        Array(5).fill("x".repeat(900)).join("\n") + "\nneedle",
      ])),
      { query: "needle", maxResults: 100 },
    );
    const output = formatSearchHits(result);
    return result.truncated && output.length <= 20_000 && output.includes("Results truncated");
  })(),
);

console.log(failures === 0 ? "\nAll search cases passed." : "\n" + failures + " case(s) failed.");
if (failures > 0) process.exit(1);