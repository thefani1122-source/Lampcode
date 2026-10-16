/** Most cases defend against inventing failures from incomplete observations.
 * No sandbox service import: that starts config, Redis and the E2B SDK. */
import { readFileSync } from "node:fs";
import { INTERACTION_SCRIPT, parseInteractionReport, tallyInteractions, formatInteractions, formatInteractionsForUser } from "../src/verify/interactions.js";
import type { InteractionFinding, InteractionKind } from "../src/verify/interactions.js";

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

const entry = { kind: "button", label: "Save", changed: false, consoleErrors: [] };
const parse = (v: unknown) => parseInteractionReport(JSON.stringify(v));
const kinds = (v: unknown) => parse(v).map((f) => f.kind);
check("clean JSON line", kinds([entry]), ["button-no-change"]);
check("prose around JSON", parseInteractionReport('starting\n' + JSON.stringify([entry]) + '\ndone').map((f) => f.kind), ["button-no-change"]);
check("same-line prose", parseInteractionReport('result: ' + JSON.stringify([entry]) + ' done').length, 1);
check("bracketed log prefix on another line", parseInteractionReport('[debug] starting\n' + JSON.stringify([entry])).length, 1);
check("truncated JSON", parseInteractionReport(JSON.stringify([entry]).slice(0, -1)), []);
check("empty stdout", parseInteractionReport(""), []);
check("garbage", parseInteractionReport("no result"), []);
for (const value of [null, 1, true, "text", {}, { entries: [entry] }, [null], ["x"], [[]]]) {
  check(`wrong shape: ${JSON.stringify(value)}`, parse(value), []);
}
check("successful control is not a finding", parse([{ ...entry, changed: true }]), []);
check("skipped false result is never a failure", parse([{ ...entry, skipped: true }]), []);
check("skipped errors are never failures", parse([{ ...entry, skipped: true, consoleErrors: ["error"] }]), []);
check("uncertain skipped marker is not coerced", parse([{ ...entry, skipped: "false" }]), []);
check("null result is not false", parse([{ ...entry, changed: null }]), []);
check("string false is not false", parse([{ ...entry, changed: "false" }]), []);
check("missing changed is uncertain", parse([{ kind: "button", label: "Save", consoleErrors: [] }]), []);
check("unknown kind is ignored", parse([{ ...entry, kind: "probe" }]), []);
check("prototype names are not kinds", parse([{ ...entry, kind: "constructor" }]), []);
check("empty label is ignored", parse([{ ...entry, label: " " }]), []);
check("wrong label is ignored", parse([{ ...entry, label: 4 }]), []);
check("wrong errors are ignored", parse([{ ...entry, consoleErrors: "error" }]), []);
check("nonstring errors are ignored", parse([{ ...entry, consoleErrors: [null] }]), []);
check("empty report", parse([]), []);
check("label brackets and escaped quotes stay inside strings", parse([{ ...entry, label: 'Save [draft] "now"' }])[0]?.symbol, 'Save [draft] "now"');
check("runtime path is retained for model", parse([{ ...entry, path: "/settings" }])[0]?.path, "/settings");
check("missing path does not invent a file", parse([entry])[0]?.path, "");
check("errors surface even when the page changes", kinds([{ ...entry, changed: true, consoleErrors: ["boom"] }]), ["console-error"]);
check("unchanged and error are separate observations", kinds([{ ...entry, consoleErrors: ["boom"] }]), ["button-no-change", "console-error"]);
ok("error detail is useful to the model", parse([{ ...entry, changed: true, consoleErrors: ["boom"] }])[0]?.detail.includes("boom") === true);
check("link kind", kinds([{ ...entry, kind: "link" }]), ["link-no-change"]);
check("form kind", kinds([{ ...entry, kind: "form" }]), ["form-no-change"]);

const allKinds: InteractionKind[] = ["button-no-change", "link-no-change", "form-no-change", "console-error"];
const findings: InteractionFinding[] = allKinds.flatMap((kind, i) => Array.from({ length: i + 1 }, () => ({ kind, path: "src/Secret.tsx", symbol: "handleSecret", detail: "secretIdentifier" })));
check("tally separates kinds", tallyInteractions(findings), { buttonsNoChange: 1, linksNoChange: 2, formsNoChange: 3, consoleErrors: 4, total: 10 });
check("empty tally", tallyInteractions([]), { buttonsNoChange: 0, linksNoChange: 0, formsNoChange: 0, consoleErrors: 0, total: 0 });
check("user report silent without findings", formatInteractionsForUser([]), []);
ok("user lines contain no paths or identifiers", formatInteractionsForUser(findings).every((line) => !["src/", ".tsx", "handleSecret", "secretIdentifier", ...allKinds].some((text) => line.includes(text))));
ok("model report names target", formatInteractions(findings).includes("src/Secret.tsx — handleSecret"));
ok("model must confirm before repairing", formatInteractions(findings).includes("not proof of a dead handler"));
ok("model cannot game the fingerprint", formatInteractions(findings).includes("Do not delete controls or add cosmetic changes"));
ok("empty report does not promise coverage", formatInteractions([]).includes("does not prove"));
const many = Array.from({ length: 40 }, () => findings[0]!);
ok("only printing is capped", formatInteractions(many).includes("10 more") && tallyInteractions(many).total === 40);
check("parsing is not capped", parse(Array.from({ length: 40 }, () => entry)).length, 40);

// These are source guards, not a claim that a browser ran. The separate local
// browser probe exercises the exported string itself, without translating it.
const imports = [...INTERACTION_SCRIPT.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
check("script imports only playwright", imports, ["playwright"]);
ok("no static imports or require escape hatch", !/\bimport\s+|\brequire\s*\(/.test(INTERACTION_SCRIPT.replace(/\/\/[^\n]*/g, "")));
ok("script never references baked renderer", !INTERACTION_SCRIPT.includes("check-render.mjs"));
ok("script opens the preview port", INTERACTION_SCRIPT.includes('http://localhost:5173'));
const service = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
ok("runtime writes into tooling directory", service.includes('sandbox.files.write(`${TOOLS_DIR}/lampcode-interact.mjs`, INTERACTION_SCRIPT)'));
// Asserts the INTENT — the baked Playwright is on the path and the runtime
// script is what runs — rather than one exact command string. The previous
// version matched the string verbatim and broke the moment routes were passed
// as arguments, which is a case failing for a change that was correct.
ok(
  "runtime supplies browser environment",
  /\$\{TOOLS_ENV\} node \$\{TOOLS_DIR\}\/lampcode-interact\.mjs/.test(service),
);
ok(
  "runtime passes the routes to probe",
  /lampcode-interact\.mjs http:\/\/localhost:5173 \$\{JSON\.stringify\(JSON\.stringify\(routes\)\)\}/.test(service),
);

// The probe used to open "/" and nothing else, so a multi-page app's own
// buttons were never touched — the owner's standing complaint, literally true
// of this script.
ok("script reads routes from its arguments", INTERACTION_SCRIPT.includes("process.argv[3]"));
ok("script loops over them", /for \(const route of routes\)/.test(INTERACTION_SCRIPT));
ok("each entry records which route it came from", INTERACTION_SCRIPT.includes("route,"));
// Without a per-page cap the home page eats the shared budget and every later
// route reports "not attempted" — the same blindness, moved one step along.
ok("the budget is spread across pages", INTERACTION_SCRIPT.includes("PER_ROUTE"));

console.log(failures === 0 ? "\nAll interaction cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
