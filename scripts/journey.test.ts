/**
 * Cases for the scripted journey (B6+). Run by `npm test`.
 *
 * WHY THIS TOOL EXISTS, said precisely, because the product already has two
 * things that look like it:
 *
 *   check_page            did this page render, and was the console clean
 *   the interaction probe does ANY control respond, on every route, automatically
 *   browser_interact      does the FEATURE work — add an item, reload, is it there
 *
 * Only the third can answer the question the user actually asked, and it is the
 * only one that needs the model to say what it wants, which is why the steps
 * are validated before a browser is ever started.
 */

import { readFileSync } from "node:fs";
import {
  MAX_JOURNEY_STEPS,
  formatJourney,
  parseJourney,
  parseJourneyReport,
  type JourneyStep,
} from "../src/verify/journey.js";

let checks = 0;
let failures = 0;
function ok(name: string, condition: boolean): void {
  checks++;
  if (condition) console.log(`✔ ${name}`);
  else { failures++; console.error(`✘ ${name}`); }
}

const steps = (raw: unknown): JourneyStep[] | string => {
  const r = parseJourney(raw);
  return "error" in r ? r.error : r.steps;
};

// ── A real journey parses ───────────────────────────────────────────────────

console.log("\n— the shape of a journey —");
{
  const parsed = steps([
    { do: "goto", route: "/" },
    { do: "type", text: "milk", into: "New item" },
    { do: "click", text: "Add" },
    { do: "expect", text: "milk" },
    { do: "goto", route: "/" },
    { do: "expect", text: "milk" },
  ]);
  ok("a six-step add-and-reload journey parses", Array.isArray(parsed) && parsed.length === 6);
  ok("the order is kept", Array.isArray(parsed) && parsed[0]?.do === "goto" && parsed[3]?.do === "expect");
}
ok("a click by selector is allowed too", Array.isArray(steps([{ do: "click", selector: "button.add" }])));
ok("expect-missing is a step", Array.isArray(steps([{ do: "expect", missing: "Loading" }])));
ok("wait for text is a step", Array.isArray(steps([{ do: "wait", forText: "Saved" }])));
ok("wait for ms is a step", Array.isArray(steps([{ do: "wait", ms: 500 }])));

// ── Rejected before a browser starts ────────────────────────────────────────

console.log("\n— rejected, with a sentence that says what to fix —");
ok("not a list", typeof steps({ do: "goto" }) === "string");
ok("empty", typeof steps([]) === "string");
ok(`more than ${MAX_JOURNEY_STEPS} steps`, typeof steps(Array.from({ length: 21 }, () => ({ do: "press", key: "Enter" }))) === "string");
ok("an unknown action", typeof steps([{ do: "screenshot" }]) === "string");
ok("a click with nothing to click", typeof steps([{ do: "click" }]) === "string");
ok("a type with no field", typeof steps([{ do: "type", text: "x" }]) === "string");
ok("a press with no key", typeof steps([{ do: "press" }]) === "string");
ok("a wait with neither", typeof steps([{ do: "wait" }]) === "string");
ok("an expect with neither", typeof steps([{ do: "expect" }]) === "string");
ok("an expect with both", typeof steps([{ do: "expect", text: "a", missing: "b" }]) === "string");

// A journey stays inside the preview. A goto that leaves it would be driving a
// browser, with the user's session, at somewhere nobody asked for.
console.log("\n— a journey stays inside the preview —");
ok("an absolute URL is refused", typeof steps([{ do: "goto", route: "https://example.com" }]) === "string");
ok("a protocol-relative URL is refused", typeof steps([{ do: "goto", route: "//example.com" }]) === "string");
ok("a bare path is refused", typeof steps([{ do: "goto", route: "cart" }]) === "string");
ok("a rooted path is fine", Array.isArray(steps([{ do: "goto", route: "/cart" }])));

// A wait is not where you sit out a slow backend.
ok("a 60-second wait is refused", typeof steps([{ do: "wait", ms: 60_000 }]) === "string");
ok("a negative wait is refused", typeof steps([{ do: "wait", ms: -1 }]) === "string");

// The error messages are for a model that has to fix the call.
{
  const message = steps([{ do: "click" }]) as string;
  ok("the message names the step", message.includes("step 1"));
  ok("and says what is missing", message.includes("`text`") || message.includes("text"));
}

// ── Reading the driver's report ─────────────────────────────────────────────

console.log("\n— the report —");
{
  const report = parseJourneyReport(JSON.stringify({
    ran: true,
    steps: [
      { step: 1, did: "go to /", ok: true, detail: "" },
      { step: 2, did: 'type "milk" into New item', ok: true, detail: "" },
      { step: 3, did: 'click "Add"', ok: false, detail: "locator resolved to 0 elements" },
    ],
    consoleErrors: ["TypeError: x is not a function"],
    finalUrl: "http://localhost:5173/",
  }));
  ok("it parses", report.ran && report.steps.length === 3);
  const text = formatJourney(report);
  ok("the summary names the failing step", text.includes("failed at step 3"));
  ok("every step is listed", text.includes("1. go to /") && text.includes("3. click"));
  ok("the failure's detail survives", text.includes("resolved to 0 elements"));
  ok("console errors are shown", text.includes("TypeError: x is not a function"));
}
{
  const allGood = parseJourneyReport(JSON.stringify({
    ran: true, steps: [{ step: 1, did: "go to /", ok: true, detail: "" }], consoleErrors: [], finalUrl: "/",
  }));
  ok("a clean journey says so", formatJourney(allGood).includes("All 1 step(s) worked"));
}
{
  // ran:false is a different fact from "a step failed", and the formatter must
  // keep them apart — the whole point of `ran` elsewhere in this codebase.
  const notRun = parseJourneyReport(JSON.stringify({ ran: false, steps: [], consoleErrors: [], finalUrl: "", reason: "there is no live preview" }));
  ok("a journey that never ran is not a failed journey", formatJourney(notRun).includes("could not run"));
  ok("and it says why", formatJourney(notRun).includes("no live preview"));
}
ok("garbage parses to not-run", !parseJourneyReport("not json").ran);
ok("empty parses to not-run", !parseJourneyReport("").ran);
ok("console errors are capped", parseJourneyReport(JSON.stringify({
  ran: true, steps: [], consoleErrors: Array.from({ length: 40 }, (_, i) => `e${i}`), finalUrl: "",
})).consoleErrors.length <= 10);

// ── The driver's own rules ──────────────────────────────────────────────────

console.log("\n— the driver —");
{
  const src = readFileSync(new URL("../src/verify/journey.ts", import.meta.url), "utf8");
  ok("one browser, one context, one page", src.includes("const context = await browser.newContext()") && (src.match(/newPage\(\)/g) ?? []).length === 1);
  ok("a failed step stops the journey", src.includes("break; // everything after a failed step"));
  ok("a hung browser cannot hold the build", src.includes("const watchdog = setTimeout"));
  ok("whatever completed is still reported on a timeout", src.includes('print(results.length > 0, "the journey timed out")'));
  ok("console errors are collected", src.includes('page.on("console"') && src.includes('page.on("pageerror"'));
  ok("controls are found by what a user sees", src.includes("page.getByText(step.text"));
  ok("fields by label or placeholder", src.includes("getByLabel") && src.includes("getByPlaceholder"));
  ok("there is no arbitrary-JavaScript step", !src.includes("page.evaluate("));

  const handler = readFileSync(new URL("../src/agents/tools/browser-interact.ts", import.meta.url), "utf8");
  ok("steps are validated before a browser starts", handler.indexOf("parseJourney(") < handler.indexOf("runJourney("));

  const defs = readFileSync(new URL("../src/agents/tools.ts", import.meta.url), "utf8");
  ok("the tool is offered to agentic builds", defs.indexOf('name: "browser_interact"') > defs.indexOf("export const AGENTIC_BUILD_TOOLS"));
  ok("it requires a sandbox", defs.includes('"shell", "browser_interact"'));
  ok("its description says what check_page cannot do", defs.includes("check_page asks whether a page"));
  ok("and that state carries between steps", defs.includes("still there in step 5"));

  const registry = readFileSync(new URL("../src/agents/tools/registry.ts", import.meta.url), "utf8");
  ok("the registry can execute it", registry.includes('["browser_interact", browserInteractHandler]'));
}

console.log(`\n${checks} journey checks, ${failures} failed`);
if (failures > 0) process.exit(1);
