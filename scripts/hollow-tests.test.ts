/** Cases for the hollow-test analyser. Most protect deliberate missed findings:
 * a repair against a correct test is a regression. Run by `npm test`. */
import { findHollowTests, tallyHollowTests, formatHollowTests, formatHollowTestsForUser } from "../src/verify/hollow-tests.js";
import type { HollowTestFinding, HollowTestKind } from "../src/verify/hollow-tests.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const scan = (source: string) => findHollowTests({ "src/cart.test.ts": source });
const kinds = (source: string) => scan(source).map((f) => f.kind).sort();
const project = 'import { total } from "./cart"; ';
const real = 'it("total", () => { expect(total(items)).toBe(30); });';

check("real application assertion", kinds(project + real), []);
check("computed value is not literal-vs-literal", kinds(project + real), []);
check("relative helper counts as project code", kinds('import { helper } from "../helper"; test("helper", () => { expect(helper()).toBe(true); });'), []);
check("non-test files are never analysed", findHollowTests({ "src/cart.ts": 'it.skip("x"); it("x", () => {});' }), []);
check("empty project", findHollowTests({}), []);
check("commented skip is ignored", kinds(project + '// it.skip("x");\n' + real), []);
check("block comments are ignored", kinds(project + '/* test.todo("x"); */' + real), []);
check("quoted fixture is not executable", kinds('const fixture = \'it.skip("x"); test("x", () => {});\';'), []);
check("template fixture is not executable", kinds('const fixture = `it.skip("x"); test("x", () => {});`;'), []);
check("escaped quotes remain inside fixtures", kinds('const fixture = "\\\"; it.skip(\\\"x\\\");";'), []);
check("glob in a string does not eat real source", kinds(project + 'const glob = "**/*"; ' + real), []);
check("computed expected value is not literal-vs-literal", kinds(project + 'it("x", () => { expect(30).toBe(total(items)); });'), []);
check("one meaningful expectation defeats every-literal claim", kinds(project + 'it("x", () => { expect(1).toBe(1); expect(total(items)).toBe(30); });'), []);
check("custom matcher is not guessed at", kinds(project + 'it("x", () => { expect(1).toMatchBusinessRule(1); });'), []);
check("objects are not primitive literals", kinds(project + 'it("x", () => { expect({ a: 1 }).toEqual({ a: 1 }); });'), []);
check("negated expectations are left alone", kinds(project + 'it("x", () => { expect(1).not.toBe(2); });'), []);
check("assertion helpers can throw", kinds(project + 'it("x", () => { assert.equal(total(items), 30); });'), []);
check("named callbacks may assert elsewhere", kinds(project + 'it("x", verifyCart);'), []);
check("expression callbacks may assert elsewhere", kinds(project + 'it("x", () => verifyCart());'), []);
check("parameter callbacks may receive assertion tools", kinds(project + 'it("x", ({ expect }) => {});'), []);
check("callback defaults may execute checks", kinds(project + 'it("x", (value = verifyCart()) => {});'), []);
check("locally defined test is not a runner", kinds('function test(name, fn) {} test("x", () => {});'), []);
check("object test methods are not runner tests", kinds('object.test("x", () => {});'), []);
check("object skip methods are not runner tests", kinds('object.it.skip("x", () => {});'), []);
check("shadowed expect is not understood", kinds(project + 'const expect = custom; ' + real), []);
check("imported lookalike runner is left alone", kinds('import { it } from "./iterator"; it.skip("x", () => {});'), []);
check("semicolonless statement boundaries are not guessed", kinds('import { it } from "vitest"\nit("x", () => {})'), []);
check("assertion reference may be used by a helper", kinds(project + 'it("x", () => { verify(total(items), expect); expect(1).toBe(1); });'), []);
check("alias imports are not assumed external", kinds('import { total } from "@/cart"; ' + real), []);
check("package imports might be workspace packages", kinds('import { total } from "cart-core"; ' + real), []);
check("side effect import may initialise app", kinds('import "./setup"; ' + real), []);
check("require may load project code", kinds('const total = require("./cart"); ' + real), []);
check("dynamic import may load project code", kinds('const cart = import("./cart"); ' + real), []);
check("remote app tests need not import app code", kinds('it("x", () => { expect(fetch(url)).toBeDefined(); });'), []);
check("file based tests need not import app code", kinds('it("x", () => { expect(readFileSync(path)).toBeDefined(); });'), []);
check("regex fixtures are not read as tests", kinds('const re = /it.skip("x")/;'), []);
check("JSX text is not read as tests", kinds('const x = <div>it.skip("x")</div>;'), []);
check("nested templates are deliberately unreadable", kinds('const x = `outer ${`it.skip("x")`}`;'), []);
check("unclosed string is left alone", kinds('it("x", () => {}); const x = "'), []);
check("unbalanced delimiters are left alone", kinds('it("x", () => {}'), []);
check("malformed input does not throw", findHollowTests({ "x.test.ts": null as unknown as string }), []);

check("missing assertions", kinds(project + 'it("x", () => { total(items); });'), ["no-assertions"]);
check("empty callback", kinds(project + 'it("x", () => { /* to do */ });'), ["empty-test", "no-assertions"]);
check("async empty callback", kinds(project + 'test("x", async () => {});'), ["empty-test", "no-assertions"]);
check("function empty callback", kinds(project + 'test("x", function() {});'), ["empty-test", "no-assertions"]);
for (const value of ["1", "true", '"a"', "'a'", "null"]) {
  check(`literal-vs-literal: ${value}`, kinds(project + `it("x", () => { expect(${value}).toBe(${value}); });`), ["literal-assertion"]);
}
check("imported expect binding is not another assertion", kinds('import { expect, it } from "vitest"; ' + project + 'it("x", () => { expect(1).toBe(1); });'), ["literal-assertion"]);
check("local mock with no project import", kinds('const total = () => 30; ' + real), ["imports-nothing"]);
for (const call of ["it.skip", "test.skip", "describe.skip", "it.todo", "test.todo", "xit", "xdescribe"]) {
  check(`disabled test: ${call}`, kinds(`${call}("x", () => {});`), ["skipped-test"]);
}
check("spec files are included", findHollowTests({ "./x.spec.jsx": 'test.todo("x");' }).map((f) => [f.kind, f.path]), [["skipped-test", "x.spec.jsx"]]);

const allKinds: HollowTestKind[] = ["no-assertions", "literal-assertion", "imports-nothing", "skipped-test", "empty-test"];
const findings: HollowTestFinding[] = allKinds.flatMap((kind, i) => Array.from({ length: i + 1 }, () => ({ kind, path: "src/private.test.ts", symbol: "privateIdentifier", detail: "privateDetail" })));
check("tally separates every kind", tallyHollowTests(findings), { noAssertions: 1, literalAssertions: 2, importsNothing: 3, skippedTests: 4, emptyTests: 5, total: 15 });
check("empty tally", tallyHollowTests([]), { noAssertions: 0, literalAssertions: 0, importsNothing: 0, skippedTests: 0, emptyTests: 0, total: 0 });
check("clean user report is silent", formatHollowTestsForUser([]), []);
ok("user lines expose no source data", formatHollowTestsForUser(findings).every((line) => !["src/", ".ts", "privateIdentifier", "privateDetail", ...allKinds].some((text) => line.includes(text))));
ok("model report identifies source", formatHollowTests(findings).includes("src/private.test.ts — privateIdentifier"));
ok("model instructions forbid weakening tests", formatHollowTests(findings).includes("Do not satisfy a finding by deleting, disabling or weakening a test"));
ok("clean report does not promise coverage", formatHollowTests([]).includes("shapes this analysis understands"));
const many = Array.from({ length: 40 }, (_, i) => ({ ...findings[0]!, path: `src/${i}.test.ts` }));
ok("only printing is capped", formatHollowTests(many).includes("10 more, not listed") && tallyHollowTests(many).total === 40);
check("scan is not capped", findHollowTests(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${i}.test.ts`, 'test.todo("x");']))).length, 40);

console.log(failures === 0 ? "\nAll hollow-test cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
