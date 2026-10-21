/**
 * Cases for applyParsedFiles, and a guard against the bug it was written to
 * kill. Run by `npm test`.
 *
 * THE BUG, found 2026-10-21. Four places in `build.ts` applied a repair's
 * parsed files with their own copy of the same loop, and three of them wrote
 * it as:
 *
 *     for (const [p, code] of Object.entries(parseFilesFromContent(…)))
 *       if (typeof code === "string" && …) allFiles[p] = code;
 *
 * `parseFilesFromContent` returns an ARRAY. So `p` was "0", "1", "2" and
 * `code` was a {path, code} object — the `typeof code === "string"` guard was
 * permanently false and **nothing was ever written**. The three loops it
 * silently killed were the fake-persistence removal, the broken-import repair
 * and the dead-code cut: three of the loops whose whole job is making the
 * agent's work correct rather than merely visible.
 *
 * TypeScript cannot catch it. After `typeof code === "string"` the value
 * narrows to `never`, and `never` is assignable to `string`, so the broken
 * assignment type-checks cleanly. That is why the guard at the bottom of this
 * file reads the source: the only reliable detector here is "this shape is
 * banned".
 */

import { readFileSync } from "node:fs";
import { applyParsedFiles, parseFilesFromContent, type ParsedFile } from "../src/agents/file-parser.js";

let checks = 0;
let failures = 0;
function ok(name: string, condition: boolean): void {
  checks++;
  if (condition) console.log(`✔ ${name}`);
  else { failures++; console.error(`✘ ${name}`); }
}

const f = (path: string, code: string): ParsedFile => ({ path, code });

// ── It writes, which is the whole point ─────────────────────────────────────

console.log("\n— it actually writes —");
{
  const target: Record<string, string> = { "src/App.tsx": "old" };
  const written = applyParsedFiles(target, [f("src/App.tsx", "new")], { allowNew: false });
  ok("an existing file is replaced", target["src/App.tsx"] === "new");
  ok("and reported", written.length === 1 && written[0] === "src/App.tsx");
}
{
  // The regression itself: the real parser's output, through the real helper.
  // If this ever returns [] again, three repair loops are dead and the suite
  // says so instead of a build quietly shipping unfixed.
  const target: Record<string, string> = { "src/App.tsx": "old" };
  const parsed = parseFilesFromContent("```filename:src/App.tsx\nconst a = 1;\n```");
  const written = applyParsedFiles(target, parsed, { allowNew: false });
  ok("the real parser's output is applied, not silently dropped", written.length === 1);
  ok("and the content landed", (target["src/App.tsx"] ?? "").includes("const a = 1;"));
}
{
  const target: Record<string, string> = {};
  const written = applyParsedFiles(target, [f("a.ts", "x"), f("b.ts", "y")], { allowNew: true });
  ok("several files in one apply", written.length === 2 && target["b.ts"] === "y");
  ok("the order written is the order parsed", written[0] === "a.ts");
}

// ── allowNew: the difference between a narrow fix and a rewrite ─────────────

console.log("\n— allowNew —");
{
  const target: Record<string, string> = { "src/App.tsx": "old" };
  const written = applyParsedFiles(target, [f("src/New.tsx", "brand new")], { allowNew: false });
  ok("a new file is refused when allowNew is false", written.length === 0);
  ok("and it is not in the map", target["src/New.tsx"] === undefined);
}
{
  const target: Record<string, string> = {};
  const written = applyParsedFiles(target, [f("src/New.tsx", "brand new")], { allowNew: true });
  ok("a new file is written when allowNew is true", written.length === 1 && target["src/New.tsx"] === "brand new");
}

// ── What must never be written ─────────────────────────────────────────────

console.log("\n— refused —");
{
  // An empty file turns a missing feature into a blank screen, which is harder
  // to diagnose than the thing it replaced.
  const target: Record<string, string> = { "a.ts": "real code" };
  const written = applyParsedFiles(target, [f("a.ts", "   \n\t\n ")], { allowNew: false });
  ok("a whitespace-only file does not overwrite real code", written.length === 0 && target["a.ts"] === "real code");
  ok("an empty file is refused", applyParsedFiles(target, [f("a.ts", "")], { allowNew: false }).length === 0);
}
{
  const target: Record<string, string> = { "vite.config.ts": "baked", "src/App.tsx": "old" };
  const written = applyParsedFiles(
    target,
    [f("vite.config.ts", "hijacked"), f("src/App.tsx", "new")],
    { allowNew: false, refuse: (p) => p === "vite.config.ts" },
  );
  ok("a refused path is not written", target["vite.config.ts"] === "baked");
  ok("and the rest of the batch still lands", written.length === 1 && target["src/App.tsx"] === "new");
}
{
  const target: Record<string, string> = { "a.ts": "A", "b.ts": "B" };
  const written = applyParsedFiles(target, [f("a.ts", "new A"), f("b.ts", "new B")], {
    allowNew: false,
    only: new Set(["a.ts"]),
  });
  ok("`only` keeps a repair inside the files a finding named", written.length === 1);
  ok("and the file outside it is untouched", target["b.ts"] === "B");
}
{
  // The input is a parse of model output, so the shape is checked rather than
  // trusted — this is the guard the dead loops thought they had.
  const target: Record<string, string> = { "a.ts": "A" };
  const junk = [
    null, undefined, "a string", 42, [],
    { path: "a.ts" }, { code: "x" }, { path: 42, code: "x" }, { path: "a.ts", code: 42 }, { path: "", code: "x" },
  ] as unknown as ParsedFile[];
  const written = applyParsedFiles(target, junk, { allowNew: true });
  ok("malformed entries are skipped, not thrown on", written.length === 0);
  ok("and nothing was corrupted", target["a.ts"] === "A" && Object.keys(target).length === 1);
}
ok("an empty parse writes nothing", applyParsedFiles({}, [], { allowNew: true }).length === 0);

// ── The guard: this shape is banned ────────────────────────────────────────

console.log("\n— the shape that caused it is banned —");
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

  ok("Object.entries is never applied to the parser's result directly",
    !/Object\.entries\(\s*parseFilesFromContent/.test(build));

  // The indirect form, which is how all three real bugs were written: the
  // result is assigned to a name, and THAT name is passed to Object.entries.
  const assigned = [...build.matchAll(/const\s+(\w+)\s*=\s*parseFilesFromContent\(/g)].map((m) => m[1]);
  ok("the scan found the parser's call sites", assigned.length > 0);
  const viaVariable = assigned.filter((name) =>
    new RegExp(`Object\\.entries\\(\\s*${name}\\s*\\)`).test(build));
  ok(`no parsed-file variable reaches Object.entries (${assigned.length} checked)`, viaVariable.length === 0);
  if (viaVariable.length > 0) console.error(`   offenders: ${viaVariable.join(", ")}`);

  // The guard that would have caught it on its own: a loop over parsed files
  // must read .path and .code, because those are the only two fields there are.
  ok("no `typeof code === \"string\"` guard survives in build.ts",
    !build.includes('typeof code === "string"'));

  // And the three loops it killed are now on the tested path, with the rule
  // each one actually needs.
  const site = (marker: string, allowNew: boolean): boolean => {
    const at = build.indexOf(marker);
    if (at < 0) return false;
    const call = build.indexOf("applyParsedFiles(", at);
    if (call < 0) return false;
    return build.slice(call, call + 300).includes(`allowNew: ${allowNew}`);
  };
  ok("the fake-persistence removal applies its files, existing only",
    site("Faked persistence found — dispatching removal", false));
  ok("the broken-import repair applies its files, and may create them",
    site("New files ARE allowed here", true));
  ok("the dead-code cut applies its files, existing only",
    site("Existing files only. A cut that CREATES a file", false));
  ok("every repair site refuses template-owned paths",
    (build.match(/refuse: isTemplateOwnedFile/g) ?? []).length >= 3);

  // The false root cause recorded against `dead=23 touched=0` is corrected in
  // place rather than deleted — a confident diagnosis that turned out wrong is
  // worth leaving visible.
  ok("the dead=23 touched=0 reading is corrected where it was written",
    build.includes("never be anything but 0"));
}

console.log(`\n${checks} apply-parsed checks, ${failures} failed`);
if (failures > 0) process.exit(1);
