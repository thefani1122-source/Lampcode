import { readFileSync } from "node:fs";
/** Focused cases for the deterministic architecture signals. */

import {
  findArchitectureGaps,
  formatArchitectureGaps,
} from "../src/verify/architecture.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, condition: boolean): void {
  check(name, condition, true);
}

const findings = (files: Record<string, string>) => findArchitectureGaps(files);
const byKind = (files: Record<string, string>, kind: string) =>
  findings(files).filter((finding) => finding.kind === kind);

// E1: cycles, with canonical reporting and a diamond left quiet.
const twoCycle = {
  "src/a.ts": `import "./b"; export const a = 1;`,
  "src/b.ts": `import "./a"; export const b = 1;`,
};
check("two-file cycle is reported once", byKind(twoCycle, "circular-import").length, 1);
ok("cycle detail names both paths and a repair", /src\/a\.ts.*src\/b\.ts.*extracting/.test(byKind(twoCycle, "circular-import")[0]?.detail ?? ""));
const threeCycle = {
  "src/a.ts": `import "./b";`,
  "src/b.ts": `import "./c";`,
  "src/c.ts": `import "./a";`,
};
check("three-file cycle is detected", byKind(threeCycle, "circular-import").length, 1);
check("self-import cycle is detected", byKind({ "src/self.ts": `import "./self";` }, "circular-import").length, 1);
const diamond = {
  "src/root.ts": `import "./left"; import "./right";`,
  "src/left.ts": `import "./leaf";`,
  "src/right.ts": `import "./leaf";`,
  "src/leaf.ts": `export const leaf = 1;`,
};
check("diamond dependency is not a cycle", byKind(diamond, "circular-import").length, 0);
check("cycle ordering is deterministic", findings({ ...twoCycle }).map((f) => f.symbol), findings({ ...twoCycle }).map((f) => f.symbol));
check("imports in comments do not create a self-cycle", byKind({ "src/self.ts": `// import "./self";\nexport const ok = 1;` }, "circular-import").length, 0);

// E2: only component-to-server/db edges cross the forbidden boundary.
const layers = {
  "src/components/Chart.tsx": `import "../db/client"; import "../server/api"; import "../lib/math";`,
  "src/db/client.ts": `export const db = {};`,
  "src/server/api.ts": `import "../db/client";`,
  "src/lib/math.ts": `export const sum = (a: number, b: number) => a + b;`,
};
const layerFindings = byKind(layers, "layer-violation");
check("component db/server edges are reported", layerFindings.length, 2);
ok("layer finding names source, target, and remediation", layerFindings.every((f) => f.detail.includes(f.path) && f.detail.includes(f.symbol) && f.detail.includes("API boundary")));
ok("component to lib and server to db are allowed", !layerFindings.some((f) => f.path === "src/server/api.ts" || f.symbol === "src/lib/math.ts"));

// E4: exactly 600 lines is allowed; generated, test, SQL, JSON, and baked files are skipped.
const repeatedLines = (n: number) => Array.from({ length: n }, (_, i) => `const n${i} = ${i};`).join("\n");
check("601 source lines are a finding", byKind({ "src/large.ts": repeatedLines(601) }, "file-too-large").length, 1);
check("600 source lines are allowed", byKind({ "src/large.ts": repeatedLines(600) }, "file-too-large").length, 0);
check("generated SQL is excluded", byKind({ "db/schema.sql": repeatedLines(5000) }, "file-too-large").length, 0);
check("JSON is excluded", byKind({ "src/data.json": repeatedLines(5000) }, "file-too-large").length, 0);
check("test files are excluded", byKind({ "src/large.test.ts": repeatedLines(601) }, "file-too-large").length, 0);
check("generated source is excluded", byKind({ "src/generated/large.ts": repeatedLines(601) }, "file-too-large").length, 0);
check("template-owned baked source is excluded", byKind({ "src/lib/utils.ts": repeatedLines(601) }, "file-too-large").length, 0);
check("clean project produces no findings", findings({ "src/App.tsx": `export default function App() { return <main />; }` }).length, 0);

// E3: exact token-normalised bodies only; tests and generated boilerplate stay quiet.
const firstBody = `function calculate(input: number) {
  const value = input;
  let result = value;
  result += 1;
  result += 2;
  result += 3;
  result += 4;
  result += 5;
  result += 6;
  return result;
}`;
const renamedBody = `function compute(seed: number) {
  // The comment and spacing are irrelevant to body identity.
  const item = seed;
  let total = item; total += 1; total += 2;
  total += 3; total += 4; total += 5; total += 6;
  return total;
}`;
const exactPair = { "src/one.ts": firstBody, "src/two.ts": renamedBody };
check("renamed locals and whitespace still match exactly", byKind(exactPair, "duplicate-logic").length, 1);
ok("duplicate finding recommends src/lib extraction", byKind(exactPair, "duplicate-logic")[0]?.detail.includes("src/lib/") ?? false);
const short = `function a(x: number) { let y = x; y++; y++; y++; return y; }`;
check("five-statement bodies are below the floor", byKind({ "src/a.ts": short, "src/b.ts": short.replace("function a", "function b") }, "duplicate-logic").length, 0);
const changedBody = firstBody.replace("result += 6;", "result += 7;");
check("one changed statement prevents an exact match", byKind({ "src/a.ts": firstBody, "src/b.ts": changedBody.replace("calculate", "compute") }, "duplicate-logic").length, 0);
check("identical test bodies are excluded", byKind({ "src/a.test.ts": firstBody, "src/b.test.ts": firstBody.replace("calculate", "compute") }, "duplicate-logic").length, 0);
check("literal and JSX return boilerplate is excluded", byKind({
  "src/a.tsx": `function a(x: number) { return <div>{x}</div>; }`,
  "src/b.tsx": `function b(y: number) { return <div>{y}</div>; }`,
}, "duplicate-logic").length, 0);
const thirdBody = renamedBody.replace("compute", "calculateAgain").replaceAll("seed", "initial").replaceAll("item", "current").replaceAll("total", "sum");
const triple = byKind({ "src/a.ts": firstBody, "src/b.ts": renamedBody, "src/c.ts": thirdBody }, "duplicate-logic");
check("three matching bodies are grouped in one finding", triple.length, 1);
ok("grouped duplicate names every location", ["src/a.ts:", "src/b.ts:", "src/c.ts:"].every((path) => triple[0]?.detail.includes(path)));
check("switch-only boilerplate is excluded", byKind({
  "src/a.ts": `function a(x: number) { switch (x) { case 1: return 1; default: return 0; } }`,
  "src/b.ts": `function b(y: number) { switch (y) { case 1: return 1; default: return 0; } }`,
}, "duplicate-logic").length, 0);
check("clean E3 project stays quiet", byKind({ "src/App.tsx": `export default function App() { return <main />; }` }, "duplicate-logic").length, 0);

const formatted = formatArchitectureGaps(findings(twoCycle));
ok("formatted output includes an actionable remediation", formatted.includes("Break this import cycle"));


// ── Wiring (E5): the gate runs on a real build, and only reports ────────────
// The module existed and nothing called it. These pin the decisions in how it
// is wired, which are as load-bearing as the detection itself.
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

  ok("the gate is called on the delivered file set", build.includes("findArchitectureGaps(allFiles)"));
  ok("after the repair chain, so it describes the final code", build.indexOf("await withTimeout(previewWork") < build.indexOf("findArchitectureGaps(allFiles)"));
  ok("it reaches the record", build.includes("architecture: architectureTally"));

  // ADVISORY. No repair dispatch, no revert, no churn to satisfy a style rule.
  const start = build.indexOf("findArchitectureGaps(allFiles)");
  const region = build.slice(start - 2200, start + 2200);
  ok("no model is dispatched over an architecture finding", !/dispatcher\.dispatch\(/.test(region));
  ok("and the decision to stay advisory is written down", build.includes("ADVISORY, and that is a decision rather than an omission"));
  ok("duplicate-logic and file-size are named as the clearest advisory cases", build.includes("`duplicate-logic` and") && build.includes("a judgement about a codebase"));

  // Every finding carries its fix; the formatter is what carries it.
  ok("findings are formatted with their remediation", build.includes("formatArchitectureGaps(architectureFindings)"));
  ok("it logs on a clean build too, so \"ran\" and \"never ran\" differ", build.includes("[build] architecture session="));
}

// Every finding's own detail must contain its remediation, not just a verdict.
{
  const findings = findArchitectureGaps({
    "src/components/Card.tsx": "import { db } from '../db/client';\nexport const Card = () => <div>{db}</div>;",
    "src/db/client.ts": "export const db = 1;",
  });
  ok("a layer violation is found", findings.some((f) => f.kind === "layer-violation"));
  ok("and it says what to do about it", findings.every((f) => f.detail.length > 30 && /[a-z]/.test(f.detail)));
}

if (failures > 0) {
  console.error(`\n${failures} architecture case(s) failed`);
  process.exit(1);
}
console.log("\nArchitecture cases passed");

