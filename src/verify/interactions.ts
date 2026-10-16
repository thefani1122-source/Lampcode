/**
 * What happened when the preview's controls were actually operated.
 *
 * An unchanged cheap fingerprint is an observation, NOT proof of a dead
 * handler. A save can work without changing the page, and equal-length text
 * can replace other text. Uncertain outcomes are skipped so a repair does not
 * rewrite working behaviour. This is separate from the baked render check.
 */
export type InteractionKind = "button-no-change" | "link-no-change" | "form-no-change" | "console-error";
export type InteractionFinding = {
  kind: InteractionKind;
  /** Runtime URL, not an invented source-file location. */
  path: string;
  symbol: string;
  /** One line, for the model that must investigate before repairing. */
  detail: string;
};

/** Written into TOOLS_DIR at runtime, so bare Playwright resolution uses the
 * already-installed tooling. No template or baked script changes are needed.
 * Each initial-page control gets a fresh browser context: a previous click
 * must not move the next selector to another page or leave its modal open.
 * This isolates browser storage, not server-side effects of operating controls.
 */
export const INTERACTION_SCRIPT = String.raw`
const entries = [];
let browser;
let printed = false;
const base = process.argv[2] || "http://localhost:5173";
const routes = JSON.parse(process.argv[3] || '["/"]');
const selector = 'button, a[href^="/"], form';
const deadline = Date.now() + 45000;
// Spread the shared budget across pages. Without a per-page cap the home page
// would consume it and every later route would report "not attempted" — the
// same blindness this change exists to remove, just moved one step along.
const PER_ROUTE = Math.max(3, Math.floor(12 / Math.max(1, routes.length)));
function print() {
  if (printed) return;
  printed = true;
  process.stdout.write(JSON.stringify(entries) + "\n");
}
// If Chromium itself stops responding, keep completed observations and mark
// pending controls skipped. A killed command with no output proves nothing.
const watchdog = setTimeout(() => {
  if (!entries.length) entries.push({ kind: "probe", label: "preview", changed: null, skipped: true, consoleErrors: [], reason: "probe timed out" });
  print();
  process.exit(0);
}, 55000);

function describe(el) {
  const kind = el.tagName === "BUTTON" ? "button" : el.tagName === "A" ? "link" : "form";
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || kind).replace(/\s+/g, " ").trim().slice(0, 160);
  return { kind, label, href: el.getAttribute("href"), id: el.id, type: el.getAttribute("type") };
}
async function fingerprint(page) {
  return page.evaluate(() => ({ title: document.title, length: document.body.innerText.length, path: location.pathname, url: location.href }));
}
async function open(context, route) {
  const page = await context.newPage();
  page.setDefaultTimeout(1500);
  const response = await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 8000 });
  if (!response || !response.ok()) throw new Error("preview did not load successfully");
  await page.waitForTimeout(300);
  return page;
}

try {
  // Dynamic import stays inside the guard: even missing browser tooling must
  // produce a skipped report rather than an uncaught module-load exception.
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, timeout: 8000 });

  // One browser, every declared route. The probe used to open "/" and nothing
  // else, so a multi-page app's own buttons were never touched — which is the
  // owner's standing complaint, and it was literally true of this script.
  for (const route of routes) {
  const discovery = await browser.newContext();
  let inventory;
  try {
    const page = await open(discovery, route);
    inventory = (await Promise.all((await page.$$(selector)).map((el) => el.evaluate(describe)))).slice(0, PER_ROUTE);
  } catch {
    await discovery.close().catch(() => {});
    entries.push({ kind: "probe", label: route, changed: null, skipped: true, consoleErrors: [], reason: "page did not load", route });
    continue;
  } finally { await discovery.close().catch(() => {}); }

  const offset = entries.length;
  for (const item of inventory) entries.push({ kind: item.kind, label: item.label, changed: null, skipped: true, consoleErrors: [], reason: "not attempted", route, path: base + route });

  for (let index = 0; index < inventory.length; index++) {
    const entry = entries[offset + index];
    if (Date.now() >= deadline) { entry.reason = "time budget exhausted"; continue; }
    let context;
    try {
      context = await browser.newContext();
      const page = await open(context, route);
      const controls = await page.$$(selector);
      const observed = (await Promise.all(controls.map((el) => el.evaluate(describe)))).slice(0, PER_ROUTE);
      // Index alone is unsafe after a reload: a dynamic list can reorder and
      // make us attribute another control's result to this one.
      if (JSON.stringify(observed) !== JSON.stringify(inventory)) { entry.reason = "control inventory changed"; continue; }
      const control = controls[index];
      if (!control || !await control.isVisible() || !await control.isEnabled()) { entry.reason = "hidden, disabled or missing"; continue; }
      const uncertainty = await control.evaluate((el) => {
        if (!el.isConnected) return "control disappeared";
        if (el.getAttribute("aria-disabled") === "true") return "disabled control";
        if (el.tagName === "A") {
          if (el.hasAttribute("download") || (el.target && el.target !== "_self")) return "download or separate browsing context";
          if (new URL(el.href).origin !== location.origin) return "outside the preview";
          if (el.href === location.href) return "already at this destination";
        }
        const form = el.tagName === "FORM" ? el : el.tagName === "BUTTON" && el.type === "submit" ? el.form : null;
        // Do not invent user data or bypass native validation to force a
        // submission. An empty required field is not a dead submit handler.
        if (form && !form.noValidate && form.querySelector(":invalid")) return "form needs valid input";
        if (form && form.target && form.target !== "_self") return "separate browsing context";
        return "";
      });
      if (uncertainty) { entry.reason = uncertainty; continue; }

      const before = await fingerprint(page);
      await page.waitForTimeout(200);
      if (JSON.stringify(before) !== JSON.stringify(await fingerprint(page))) { entry.reason = "page not settled"; continue; }
      entry.path = before.url;
      const errors = [];
      let sideEffect = false;
      page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text().slice(0, 500)); });
      page.on("pageerror", (err) => errors.push(String(err).slice(0, 500)));
      page.on("request", () => { sideEffect = true; });
      page.on("download", () => { sideEffect = true; });
      page.on("popup", () => { sideEffect = true; });
      page.on("dialog", (dialog) => { sideEffect = true; void dialog.dismiss().catch(() => {}); });
      await page.evaluate(() => {
        window.__lampcodeInteractionMutation = false;
        new MutationObserver(() => { window.__lampcodeInteractionMutation = true; }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        window.__lampcodeInteractionState = () => JSON.stringify([...document.querySelectorAll("input,select,textarea,details")].map((e) => [e.value, e.checked, e.open]));
        window.__lampcodeInteractionBefore = window.__lampcodeInteractionState();
      });
      if (entry.kind === "form") {
        await control.evaluate((form) => {
          if (!form.isConnected) throw new Error("form disappeared");
          // The prototype avoids an input named requestSubmit shadowing the
          // method. requestSubmit preserves validation and submit listeners.
          HTMLFormElement.prototype.requestSubmit.call(form);
        });
      } else {
        await control.click({ timeout: 1500 });
      }
      await page.waitForTimeout(500);
      const after = await fingerprint(page);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const subtle = await page.evaluate(() => window.__lampcodeInteractionMutation || (window.__lampcodeInteractionState && window.__lampcodeInteractionState() !== window.__lampcodeInteractionBefore));
      entry.consoleErrors = [...new Set(errors)];
      // Network requests, dialogs, DOM mutations and input state can all be
      // real work invisible to the cheap fingerprint. Do not call them dead.
      if (!changed && (sideEffect || subtle)) { entry.reason = "effect outside the fingerprint"; continue; }
      entry.changed = changed;
      entry.skipped = false;
      delete entry.reason;
    } catch {
      // Detached selectors, actionability timeouts and destroyed execution
      // contexts do not establish whether the control worked.
      entry.reason = "control could not be observed reliably";
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }
  }
} catch {
  entries.push({ kind: "probe", label: "preview", changed: null, skipped: true, consoleErrors: [], reason: "browser or preview unavailable" });
} finally {
  if (browser) await browser.close().catch(() => {});
  clearTimeout(watchdog);
  print();
}
`;

const MAX_REPORTED = 30;
const NO_CHANGE: Record<string, InteractionKind> = {
  button: "button-no-change", link: "link-no-change", form: "form-no-change",
};

/** Read a complete JSON array inside prose, tracking quotes rather than
 * slicing to the last bracket (which may belong to a later log message).
 * A truncated array is never salvaged into apparently complete evidence. */
function reportArray(stdout: string): unknown[] | undefined {
  const start = stdout.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (quoted) {
      if (c === "\\") { i++; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(stdout.slice(start, i + 1));
        return Array.isArray(value) ? value : undefined;
      } catch { return undefined; } // malformed evidence is not a finding
    }
  }
  return undefined;
}

export function parseInteractionReport(stdout: string): InteractionFinding[] {
  if (typeof stdout !== "string") return [];
  try {
    if (!Array.isArray(JSON.parse(stdout))) return []; // do not mine a valid but wrong-shaped envelope
  } catch { /* Extra prose is allowed; the complete array is read below. */ }
  // Prefer the script's complete line so bracketed log prefixes do not hide it.
  const candidates = [stdout, ...stdout.split(/\r?\n/)];
  let report: unknown[] | undefined;
  for (const line of candidates) {
    const candidate = reportArray(line);
    if (candidate && candidate.some((v) => v && typeof v === "object" && "kind" in v)) { report = candidate; break; }
  }
  const findings: InteractionFinding[] = [];
  for (const value of report ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue; // wrong-shaped log output
    const e = value as Record<string, unknown>;
    const kind = typeof e.kind === "string" && Object.hasOwn(NO_CHANGE, e.kind) ? NO_CHANGE[e.kind] : undefined;
    if (!kind || typeof e.label !== "string" || !e.label.trim()) continue; // unknown controls have no defined interpretation
    if (e.skipped !== undefined && e.skipped !== false) continue; // a skipped entry is NEVER a failure, including its errors
    if (typeof e.changed !== "boolean" || !Array.isArray(e.consoleErrors) || !e.consoleErrors.every((s) => typeof s === "string")) continue; // no coercion of uncertain evidence
    const path = typeof e.path === "string" ? e.path : "";
    const symbol = e.label;
    if (!e.changed) findings.push({ kind, path, symbol, detail: "no visible response was observed during the brief check — confirm the intended effect before repairing; this fingerprint can miss working behaviour" });
    if (e.consoleErrors.length > 0) findings.push({ kind: "console-error", path, symbol, detail: `browser errors during the interaction — investigate: ${e.consoleErrors.join("; ").replace(/\s+/g, " ").slice(0, 1000)}` });
  }
  return findings;
}

export type InteractionTally = { buttonsNoChange: number; linksNoChange: number; formsNoChange: number; consoleErrors: number; total: number };
const TALLY_FIELD: Record<InteractionKind, keyof Omit<InteractionTally, "total">> = {
  "button-no-change": "buttonsNoChange", "link-no-change": "linksNoChange", "form-no-change": "formsNoChange", "console-error": "consoleErrors",
};
export function tallyInteractions(findings: InteractionFinding[]): InteractionTally {
  const t: InteractionTally = { buttonsNoChange: 0, linksNoChange: 0, formsNoChange: 0, consoleErrors: 0, total: 0 };
  for (const f of findings) { t[TALLY_FIELD[f.kind]]++; t.total++; }
  return t;
}

export function formatInteractions(findings: InteractionFinding[]): string {
  if (!findings.length) return "No interaction findings. Skipped or unobserved controls are not verified; an empty report does not prove the app works.";
  const shown = findings.slice(0, MAX_REPORTED);
  return [
    `${findings.length} interaction finding(s):`, "",
    ...shown.map((f) => `- ${f.path || "preview"} — ${f.symbol}: ${f.detail}`),
    ...(findings.length > shown.length ? ["", `… and ${findings.length - shown.length} more, not listed.`] : []), "",
    "Reproduce each observation and read the implementation before changing it. A brief unchanged fingerprint is not proof of a dead handler. Confirm the intended behaviour, then repair it. Do not delete controls or add cosmetic changes merely to satisfy this check.",
  ].join("\n");
}

const HUMAN: Record<InteractionKind, string> = {
  "button-no-change": "buttons showed no visible response during the check",
  "link-no-change": "links showed no visible response during the check",
  "form-no-change": "forms showed no visible response during the check",
  "console-error": "interactions produced browser errors",
};
/** Labels and errors may contain paths or identifiers, so only counts and
 * fixed prose cross into the user-facing report. */
export function formatInteractionsForUser(findings: InteractionFinding[]): string[] {
  if (!findings.length) return [];
  const counts = new Map<InteractionKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return ["Some controls need a closer look:", ...[...counts].map(([kind, count]) => `  • ${HUMAN[kind]} (${count})`), "A brief check can miss working behaviour, so these results need confirmation."];
}
