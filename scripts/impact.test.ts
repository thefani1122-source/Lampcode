import { formatImpact, impactAnalysis } from "../src/verify/impact.js";

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

const shared = {
  "src/lib/label.ts": "export function formatLabel(value: string) { return value.trim(); }",
  "src/components/First.tsx": 'import { formatLabel } from "../lib/label"; export const First = () => <span>{formatLabel("a")}</span>;',
  "src/components/Second.tsx": 'import { formatLabel } from "../lib/label"; export const Second = () => <span>{formatLabel("b")}</span>;',
  "src/pages/Route.tsx": 'import { formatLabel } from "../lib/label"; const path = "/reports"; export const Route = () => <main path="/reports">{formatLabel(path)}</main>;',
};
const sharedReport = impactAnalysis(shared, "formatLabel");
check("symbol callers and a declared route are included", [sharedReport.callers.length, sharedReport.routes], [3, ["/reports"]]);

const isolated = impactAnalysis({ "src/lib/orphan.ts": "export function lone() { return 1; }" }, "lone");
check("isolated definition is a valid small impact report", [isolated.callers, isolated.routes, isolated.untested], [[], [], ["src/lib/orphan.ts"]]);

const covered = impactAnalysis({
  "src/lib/calc.ts": "export function calc(value: number) { return value + 1; }",
  "src/pages/Calc.tsx": 'import { calc } from "../lib/calc"; export const Calc = () => <p>{calc(1)}</p>;',
  "src/lib/calc.test.ts": 'import { calc } from "./calc"; if (calc(1) !== 2) throw new Error("bad");',
}, "calc");
check("a test is covering only through a real direct import", [covered.tests, covered.untested], [["src/lib/calc.test.ts"], ["src/pages/Calc.tsx"]]);

const crosses = impactAnalysis({
  "src/server/auth.ts": "export function checkAuth() { return true; }",
  "src/components/Private.tsx": 'import { checkAuth } from "../server/auth"; export const Private = () => <b>{String(checkAuth())}</b>;',
}, "checkAuth");
check("frontend and server together cross the auth boundary", crosses.crossesAuthBoundary, true);

const serverDb = impactAnalysis({
  "src/db/query.ts": "export function readRows() { return []; }",
  "src/server/handler.ts": 'import { readRows } from "../db/query"; export function handler() { return readRows(); }',
}, "readRows");
check("server and database alone are not an auth boundary", serverDb.crossesAuthBoundary, false);

const absent = impactAnalysis(shared, "notThere");
check("missing symbol has no fabricated impact", [absent.callers, absent.routes, absent.tests, absent.untested, absent.crossesAuthBoundary], [[], [], [], [], false]);

const malformed = impactAnalysis({
  "src/core/value.ts": "export function value() { return 1; }",
  "src/broken.ts": "export function broken( {",
}, "value");
ok("malformed source is disclosed as degraded", malformed.degraded && malformed.untested.includes("src/core/value.ts"));

const many: Record<string, string> = { "src/lib/run.ts": "export function run() {}" };
for (let index = 0; index < 30; index++) {
  many[`src/pages/P${index}.tsx`] = 'import { run } from "../lib/run"; export const Page = () => <span>{run()}</span>;';
}
const capped = impactAnalysis(many, "run");
check("lists cap at 25 and retain omitted counts", [capped.callers.length, capped.omitted.callers, capped.untested.length, capped.omitted.untested], [25, 5, 25, 6]);
ok("formatted impact makes truncation visible", formatImpact(capped).includes("5 omitted"));

const oneHop = impactAnalysis({
  "src/lib/base.ts": "export function base() { return 1; }",
  "src/components/Direct.tsx": 'import { base } from "../lib/base"; export function Direct() { return base(); }',
  "src/pages/Second.tsx": 'import { Direct } from "../components/Direct"; export const Second = () => <Direct />;',
  "src/app/Third.tsx": 'import { Second } from "../pages/Second"; export const Third = () => <Second />;',
}, "base");
check("one-hop radius stops at importers of direct reference files", oneHop.untested.includes("src/pages/Second.tsx") && !oneHop.untested.includes("src/app/Third.tsx"), true);

const sameName = impactAnalysis({
  "src/lib/target.ts": "export function renderCard() { return 1; }",
  "src/pages/Target.tsx": 'import { renderCard } from "../lib/target"; export const Target = () => <p>{renderCard()}</p>;',
  "src/lib/unrelated.ts": "export function other() { const renderCard = 2; return renderCard; }",
}, "renderCard");
check("same-named unrelated declaration does not create fake caller impact", [sameName.callers, sameName.untested], [[], []]);

if (failures > 0) {
  console.error(`\n${failures} impact case(s) failed.`);
  process.exit(1);
}
console.log("\nAll impact cases passed.");

