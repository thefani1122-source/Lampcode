/**
 * Browser-side storage inventory. Values are redacted or clipped before the
 * single JSON line reaches command output.
 *
 * Two exports, one body. `STORAGE_BROWSER_SNIPPET` is the part that runs IN the
 * page and returns the snapshot; `STORAGE_SCRIPT` is a Playwright driver that
 * loads a route and prints one JSON line.
 *
 * They are split because the original was both at once — it read `localStorage`
 * and wrote to `process.stdout`, so it could not run in either place: a page
 * has no `process`, and Node has no `localStorage`. The redaction below is the
 * original code, unchanged, and it stays on the browser side on purpose: a
 * secret-looking value must never cross into stdout, where it would reach a log.
 *
 * The snippet is also evaluated by the interaction probe, in the same page it
 * just clicked through. That matters more than it looks: a separate browser
 * starts with empty storage, so state written BY a user action can only be seen
 * from inside the session that performed it.
 */
export const STORAGE_BROWSER_SNIPPET = String.raw`(async () => {
const MAX_PREVIEW = 80;
const SECRET_KEY = /token|secret|key|password|jwt|session/i;
function bytes(value) { return new TextEncoder().encode(value).length; }
function entry(key, value) {
  return {
    key,
    bytes: bytes(value),
    preview: SECRET_KEY.test(key) ? "[redacted]" : value.slice(0, MAX_PREVIEW),
  };
}
function captureStore(getStore) {
  try {
    const store = getStore();
    const entries = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (typeof key !== "string") continue;
      const value = store.getItem(key);
      if (typeof value === "string") entries.push(entry(key, value));
    }
    return { entries, ok: true };
  } catch {
    return { entries: [], ok: false };
  }
}
async function captureDatabases() {
  try {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
      return { names: [], ok: false };
    }
    const databases = await indexedDB.databases();
    return {
      names: Array.isArray(databases) ? databases.map((db) => db && typeof db.name === "string" ? db.name : "").filter(Boolean) : [],
      ok: Array.isArray(databases),
    };
  } catch {
    return { names: [], ok: false };
  }
}
const local = captureStore(() => localStorage);
const session = captureStore(() => sessionStorage);
const indexed = await captureDatabases();
// ran is an OR across three independent capabilities on purpose. Safari and
// every pre-2023 Chromium have no indexedDB.databases(), and a page served
// without a secure context can throw on localStorage alone — losing the two
// that did work because the third was unavailable would report "no stored
// state" about an app that has plenty.
return {
  local: local.entries,
  session: session.entries,
  indexedDb: indexed.names,
  ran: local.ok || session.ok || indexed.ok,
};
})()`;

/**
 * Standalone capture: load one route in a fresh browser and print the snapshot.
 *
 * Used when the interaction probe did not run, so there is no live page to read
 * from. A fresh browser only sees state the app writes on load — which is real
 * evidence (a theme, a seeded cart, a cached list) but is NOT evidence about
 * what a click persists. The caller records which path produced the snapshot.
 */
export const STORAGE_SCRIPT = `
let browser;
let printed = false;
const base = process.argv[2] || "http://localhost:5173";
const route = process.argv[3] || "/";
const EMPTY = { local: [], session: [], indexedDb: [], ran: false };
const SNIPPET = ${JSON.stringify(STORAGE_BROWSER_SNIPPET)};
function print(snapshot) {
  if (printed) return;
  printed = true;
  process.stdout.write(JSON.stringify(snapshot) + "\\n");
}
// A hung Chromium must not hold the build. Nothing captured means ran:false,
// which is the honest answer and is kept apart from "captured, found nothing".
const watchdog = setTimeout(() => { print(EMPTY); process.exit(0); }, 40000);
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, timeout: 8000 });
  const page = await browser.newPage();
  try {
    await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch {}
  // Give an app that writes on mount a moment to do it.
  await page.waitForTimeout(1200);
  const snapshot = await page.evaluate(SNIPPET).catch(() => EMPTY);
  print(snapshot && typeof snapshot === "object" ? snapshot : EMPTY);
} catch {
  print(EMPTY);
} finally {
  if (browser) await browser.close().catch(() => {});
  clearTimeout(watchdog);
}
`;
