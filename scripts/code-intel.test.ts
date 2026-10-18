import { codeIntel, formatCodeIntel } from "../src/verify/code-intel.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const files = {
  "src/math.ts": "export function total(items: number[]): number { return items.reduce((a, b) => a + b, 0); }",
  "src/one.ts": 'import { total } from "./math"; export const one = total([1]);',
  "src/two.ts": 'import { total } from "./math"; export const two = total([2]);',
};
const basic = codeIntel(files, { symbol: "total" });
check("finds definition and references from two files", [basic.definition?.path, basic.references.map((ref) => ref.path)], ["src/math.ts", ["src/one.ts", "src/two.ts"]]);
check("does not count declaration as reference", basic.references.some((ref) => ref.path === "src/math.ts"), false);
check("missing symbol is an exact empty result", codeIntel(files, { symbol: "absent" }), { references: [], degraded: false });

const broken = codeIntel({
  ...files,
  "src/broken.ts": 'import { total } from "./math"; total(;',
}, { symbol: "total" });
ok("syntax-broken file does not discard valid compiler results", broken.definition?.path === "src/math.ts" && broken.references.some((ref) => ref.path === "src/one.ts") && broken.degraded);

const manyCalls: Record<string, string> = { "src/target.ts": "export function ping(): void {}" };
for (let i = 0; i < 45; i++) manyCalls[`src/call-${i}.ts`] = 'import { ping } from "./target"; ping();';
const capped = codeIntel(manyCalls, { symbol: "ping" });
check("caps references and keeps omitted count", [capped.references.length, capped.referencesOmitted], [40, 5]);
ok("formatter states omitted reference count", formatCodeIntel(capped).includes("5 additional reference(s) omitted"));

const pathResult = codeIntel({ "src/api.ts": "export function load() {}\nexport class Store {}\nexport interface Item {}\nexport type Key = string;\nexport const LIMIT = 3;\nconst hidden = 4;" }, { path: "src/api.ts" });
check("path mode includes useful symbols and kinds", pathResult.symbols?.map(({ name, kind }) => [name, kind]), [["load", "function"], ["Store", "class"], ["Item", "interface"], ["Key", "type"], ["LIMIT", "constant"]]);

const componentFiles = {
  "src/Card.tsx": "export function Card() { return <article />; }",
  "src/Page.tsx": 'import { Card } from "./Card"; export const Page = () => <Card />;',
};
const component = codeIntel(componentFiles, { symbol: "Card" });
check("TSX component declaration resolves to its use", [component.definition?.path, component.references.map((ref) => ref.path)], ["src/Card.tsx", ["src/Page.tsx"]]);

const sameName = codeIntel({
  "src/a.ts": "export function read() { const state = 1; return state; }",
  "src/b.ts": "export function write() { const state = 2; return state; }",
}, { symbol: "state" });
check("ambiguous same-named unrelated locals are not combined", sameName, { references: [], degraded: false });

// ── degraded textual evidence from files that do not parse ────────────────────

const brokenCaller = codeIntel({
  "src/target.ts": "export function ping() {}",
  "src/broken-caller.ts": 'import { ping } from "./target"; ping(;',
}, { symbol: "ping" });
ok(
  "a broken caller adds a degraded possible reference without losing the definition",
  brokenCaller.definition?.path === "src/target.ts" &&
    brokenCaller.references.some((ref) => ref.path === "src/broken-caller.ts" && ref.degraded === true) &&
    brokenCaller.degraded,
);

const ambiguousWithBrokenText = codeIntel({
  "src/a.ts": "export function read() { const state = 1; return state; }",
  "src/b.ts": "export function write() { const state = 2; return state; }",
  "src/broken.ts": "state(;",
}, { symbol: "state" });
check(
  "broken-file spelling cannot resolve ambiguity between valid compiler symbols",
  ambiguousWithBrokenText,
  { references: [], degraded: true },
);

const brokenMany: Record<string, string> = {
  "src/target.ts": "export function pulse() {}",
  "src/broken-many.ts": `${Array.from({ length: 45 }, () => "pulse();").join("\n")}\nconst invalid: = ;`,
};
const brokenCapped = codeIntel(brokenMany, { symbol: "pulse" });
check("broken-file matches obey the 40-reference cap and omitted count", [
  brokenCapped.references.length,
  brokenCapped.referencesOmitted,
  brokenCapped.references.every((ref) => ref.degraded === true),
], [40, 5, true]);

const brokenReversed = Object.fromEntries(Object.entries(brokenMany).reverse());
check(
  "broken-file fallback ordering is deterministic",
  codeIntel(brokenReversed, { symbol: "pulse" }),
  brokenCapped,
);

const reversed = Object.fromEntries(Object.entries(files).reverse());
check("result ordering is independent of object insertion order", codeIntel(reversed, { symbol: "total" }), basic);
check("empty project does not throw", codeIntel({}, { symbol: "anything" }), { references: [], degraded: false });

if (failures > 0) {
  console.error(`\n${failures} code-intel case(s) failed.`);
  process.exit(1);
}
console.log("\nAll code-intel cases passed.");

