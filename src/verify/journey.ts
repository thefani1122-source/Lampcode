/**
 * A scripted journey through the running app (B6+).
 *
 * The interaction probe already operates every control on every route, and
 * that is a different thing from this. It answers "does anything respond when
 * this is clicked" across the whole app, automatically, with no idea what the
 * app is FOR. It cannot answer "add an item called milk, then check it is still
 * there after a reload" — which is the only question that settles whether the
 * feature the person asked for actually works.
 *
 * So this is the model's own hands: a short list of steps, run in ONE browser
 * session so state carries from step to step, with every step reported
 * separately. A journey that fails at step 4 of 6 is far more useful than a
 * boolean, because step 4 is the bug.
 *
 * Deliberately small vocabulary. `goto`, `click`, `type`, `press`, `wait`,
 * `expect`. No arbitrary JavaScript: a step that can run anything is a `shell`
 * in a browser, with none of shell-policy's protection, and it would also be
 * able to read the page's own storage — where the app keeps its session token.
 */

export type JourneyStep =
  | { do: "goto"; route: string }
  | { do: "click"; text?: string; selector?: string }
  | { do: "type"; text: string; into: string }
  | { do: "press"; key: string }
  | { do: "wait"; ms?: number; forText?: string }
  | { do: "expect"; text?: string; missing?: string };

export type JourneyStepResult = {
  step: number;
  did: string;
  ok: boolean;
  /** What was seen. On a failure this is the whole point of the report. */
  detail: string;
};

export type JourneyReport = {
  ran: boolean;
  steps: JourneyStepResult[];
  consoleErrors: string[];
  finalUrl: string;
  /** Why the journey could not run at all. Empty when it did. */
  reason?: string;
};

/** Enough for a real flow, few enough that one tool call cannot become a test suite. */
export const MAX_JOURNEY_STEPS = 20;

/**
 * Validate what the model asked for, before a browser is started.
 *
 * Returns the steps it may run, or a sentence saying what is wrong with them.
 * Pure, so the cases cover every shape without a sandbox.
 */
export function parseJourney(raw: unknown): { steps: JourneyStep[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "`steps` must be a list of steps." };
  if (raw.length === 0) return { error: "`steps` is empty — say what to do." };
  if (raw.length > MAX_JOURNEY_STEPS) {
    return { error: `That is ${raw.length} steps; at most ${MAX_JOURNEY_STEPS} run in one journey. Split it, or check the important part first.` };
  }

  const steps: JourneyStep[] = [];
  for (const [index, value] of raw.entries()) {
    const at = `step ${index + 1}`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: `${at} is not an object.` };
    }
    const s = value as Record<string, unknown>;
    const action = typeof s["do"] === "string" ? s["do"] : "";
    const str = (key: string): string => (typeof s[key] === "string" ? (s[key] as string).trim() : "");

    switch (action) {
      case "goto": {
        const route = str("route");
        if (!route.startsWith("/")) return { error: `${at}: \`route\` must start with "/" — journeys stay inside the preview.` };
        if (route.startsWith("//")) return { error: `${at}: \`route\` must be a path in this app, not another site.` };
        steps.push({ do: "goto", route });
        break;
      }
      case "click": {
        const text = str("text");
        const selector = str("selector");
        if (!text && !selector) return { error: `${at}: a click needs \`text\` (what the user would see) or \`selector\`.` };
        steps.push({ do: "click", ...(text ? { text } : {}), ...(selector ? { selector } : {}) });
        break;
      }
      case "type": {
        const text = str("text");
        const into = str("into");
        if (!into) return { error: `${at}: \`into\` must say which field — its label, placeholder or a selector.` };
        steps.push({ do: "type", text, into });
        break;
      }
      case "press": {
        const key = str("key");
        if (!key) return { error: `${at}: \`key\` is required, for example "Enter".` };
        steps.push({ do: "press", key });
        break;
      }
      case "wait": {
        const forText = str("forText");
        const ms = typeof s["ms"] === "number" ? s["ms"] : undefined;
        if (!forText && ms === undefined) return { error: `${at}: wait for \`forText\` or give \`ms\`.` };
        if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > 5000)) {
          return { error: `${at}: \`ms\` must be between 0 and 5000. A journey is not where you wait out a slow backend.` };
        }
        steps.push({ do: "wait", ...(ms === undefined ? {} : { ms }), ...(forText ? { forText } : {}) });
        break;
      }
      case "expect": {
        const text = str("text");
        const missing = str("missing");
        if (!text && !missing) return { error: `${at}: expect needs \`text\` (must be on the page) or \`missing\` (must not be).` };
        if (text && missing) return { error: `${at}: give \`text\` or \`missing\`, not both.` };
        steps.push({ do: "expect", ...(text ? { text } : {}), ...(missing ? { missing } : {}) });
        break;
      }
      default:
        return { error: `${at}: "${action || "(none)"}" is not a step. Use goto, click, type, press, wait or expect.` };
    }
  }
  return { steps };
}

/** Parse the driver's single JSON line. Never throws. */
export function parseJourneyReport(stdout: string): JourneyReport {
  const empty: JourneyReport = { ran: false, steps: [], consoleErrors: [], finalUrl: "" };
  if (typeof stdout !== "string") return empty;
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return empty;
  try {
    const value = JSON.parse(line) as Partial<JourneyReport>;
    if (typeof value !== "object" || value === null) return empty;
    return {
      ran: value.ran === true,
      steps: Array.isArray(value.steps)
        ? value.steps.filter((s): s is JourneyStepResult =>
            !!s && typeof s === "object" && typeof (s as JourneyStepResult).did === "string")
        : [],
      consoleErrors: Array.isArray(value.consoleErrors)
        ? value.consoleErrors.filter((e): e is string => typeof e === "string").slice(0, 10)
        : [],
      finalUrl: typeof value.finalUrl === "string" ? value.finalUrl : "",
      ...(typeof value.reason === "string" && value.reason ? { reason: value.reason } : {}),
    };
  } catch {
    return empty;
  }
}

/**
 * The report, for the model that has to act on it.
 *
 * A failure names the step that failed and stops describing the rest, because
 * everything after a failed step ran against a state the journey did not
 * intend — reporting those as failures too would bury the one that matters.
 */
export function formatJourney(report: JourneyReport): string {
  if (!report.ran) {
    return `The journey could not run: ${report.reason || "the preview was not available"}.`;
  }
  const lines = report.steps.map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.step}. ${s.did}${s.detail ? ` — ${s.detail}` : ""}`);
  const failedAt = report.steps.find((s) => !s.ok);
  const head = failedAt
    ? `The journey failed at step ${failedAt.step}.`
    : `All ${report.steps.length} step(s) worked.`;
  const errors = report.consoleErrors.length > 0
    ? `\n\nConsole errors during the journey:\n${report.consoleErrors.map((e) => `- ${e}`).join("\n")}`
    : "";
  const where = report.finalUrl ? `\n\nEnded on: ${report.finalUrl}` : "";
  return `${head}\n\n${lines.join("\n")}${errors}${where}`;
}

/**
 * The sandbox-side driver.
 *
 * One browser, one context, one page, for the whole journey — that is what
 * makes it a journey rather than a series of unrelated clicks. A step that
 * throws is recorded and the run STOPS: continuing past a failed step tests a
 * state nobody asked for.
 */
export const JOURNEY_SCRIPT = String.raw`
let browser;
let printed = false;
const base = process.argv[2] || "http://localhost:5173";
const steps = JSON.parse(process.argv[3] || "[]");
const results = [];
const consoleErrors = [];
let finalUrl = "";

function print(ran, reason) {
  if (printed) return;
  printed = true;
  process.stdout.write(JSON.stringify({ ran, steps: results, consoleErrors: consoleErrors.slice(0, 10), finalUrl, reason: reason || "" }) + "\n");
}
// A hung browser must not hold the build. Whatever was completed is still
// reported — a killed command with no output proves nothing.
const watchdog = setTimeout(() => { print(results.length > 0, "the journey timed out"); process.exit(0); }, 75000);

function describe(step) {
  switch (step.do) {
    case "goto":   return "go to " + step.route;
    case "click":  return "click " + (step.text ? '"' + step.text + '"' : step.selector);
    case "type":   return 'type "' + step.text + '" into ' + step.into;
    case "press":  return "press " + step.key;
    case "wait":   return step.forText ? 'wait for "' + step.forText + '"' : "wait " + step.ms + "ms";
    case "expect": return step.missing ? 'expect "' + step.missing + '" to be gone' : 'expect "' + step.text + '"';
    default:       return step.do;
  }
}

// Find a control the way a person would: by what it says. A selector is
// accepted too, because sometimes there is no visible text.
function locate(page, step) {
  if (step.selector) return page.locator(step.selector).first();
  return page.getByText(step.text, { exact: false }).first();
}
function field(page, into) {
  if (/^[.#\[]/.test(into)) return page.locator(into).first();
  return page.getByLabel(into, { exact: false }).first()
    .or(page.getByPlaceholder(into, { exact: false }).first())
    .first();
}

try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, timeout: 8000 });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push(String(e && e.message ? e.message : e).slice(0, 200)));

  const first = await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 15000 });
  if (!first || !first.ok()) { print(false, "the preview did not load"); process.exit(0); }
  await page.waitForTimeout(400);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const did = describe(step);
    try {
      if (step.do === "goto") {
        await page.goto(base + step.route, { waitUntil: "domcontentloaded", timeout: 10000 });
        await page.waitForTimeout(300);
      } else if (step.do === "click") {
        await locate(page, step).click({ timeout: 4000 });
        await page.waitForTimeout(250);
      } else if (step.do === "type") {
        const target = field(page, step.into);
        await target.fill(step.text, { timeout: 4000 });
      } else if (step.do === "press") {
        await page.keyboard.press(step.key);
        await page.waitForTimeout(250);
      } else if (step.do === "wait") {
        if (step.forText) await page.getByText(step.forText, { exact: false }).first().waitFor({ timeout: 5000 });
        else await page.waitForTimeout(step.ms);
      } else if (step.do === "expect") {
        const needle = step.missing || step.text;
        const count = await page.getByText(needle, { exact: false }).count();
        if (step.missing && count > 0) throw new Error('"' + needle + '" is still on the page');
        if (step.text && count === 0) throw new Error('"' + needle + '" is not on the page');
      }
      results.push({ step: i + 1, did, ok: true, detail: "" });
    } catch (err) {
      const message = String(err && err.message ? err.message : err).split("\n")[0].slice(0, 200);
      results.push({ step: i + 1, did, ok: false, detail: message });
      break; // everything after a failed step would run against a state nobody asked for
    }
  }

  finalUrl = page.url();
  print(true, "");
} catch (err) {
  print(results.length > 0, String(err && err.message ? err.message : err).slice(0, 200));
} finally {
  if (browser) await browser.close().catch(() => {});
  clearTimeout(watchdog);
}
`;
