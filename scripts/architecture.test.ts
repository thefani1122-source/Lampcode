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

const formatted = formatArchitectureGaps(findings(twoCycle));
ok("formatted output includes an actionable remediation", formatted.includes("Break this import cycle"));

if (failures > 0) {
  console.error(`\n${failures} architecture case(s) failed`);
  process.exit(1);
}
console.log("\nArchitecture cases passed");

