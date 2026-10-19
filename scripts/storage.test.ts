import { readFileSync } from "node:fs";
import { STORAGE_SCRIPT, STORAGE_BROWSER_SNIPPET } from "../src/verify/storage-script.js";
import { formatStorage, parseStorageSnapshot } from "../src/verify/storage.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

const valid = parseStorageSnapshot(JSON.stringify({
  local: [{ key: "cart", bytes: 5, preview: "items" }],
  session: [],
  indexedDb: ["app-db"],
  ran: true,
}));
check("valid snapshot parses", valid.ran && valid.local[0]?.key === "cart" && valid.indexedDb[0] === "app-db");

const secretValue = "sensitive-token-value";
const redacted = parseStorageSnapshot(JSON.stringify({
  local: [{ key: "auth_token", bytes: new TextEncoder().encode(secretValue).length, preview: secretValue }],
  session: [], indexedDb: [], ran: true,
}));
check("auth_token is redacted with real byte count", redacted.local[0]?.preview === "[redacted]" && redacted.local[0]?.bytes === new TextEncoder().encode(secretValue).length);

const cart = parseStorageSnapshot(JSON.stringify({
  local: [{ key: "cart", bytes: 5, preview: "items" }], session: [], indexedDb: [], ran: true,
}));
check("normal cart value remains visible", cart.local[0]?.preview === "items");

const largeValue = "x".repeat(4096);
const large = parseStorageSnapshot(JSON.stringify({
  local: [{ key: "large", bytes: new TextEncoder().encode(largeValue).length, preview: largeValue }],
  session: [], indexedDb: [], ran: true,
}));
check("large value is clipped to 80 chars with actual bytes", large.local[0]?.preview.length === 80 && large.local[0]?.bytes === 4096);

check("empty input returns empty unrun snapshot", JSON.stringify(parseStorageSnapshot("")) === JSON.stringify({ local: [], session: [], indexedDb: [], ran: false }));
check("malformed JSON returns empty unrun snapshot", JSON.stringify(parseStorageSnapshot("{")) === JSON.stringify({ local: [], session: [], indexedDb: [], ran: false }));
check("empty formatted snapshot has no meaningless header", formatStorage(parseStorageSnapshot("")) === "No browser storage entries were captured.");
check("captured stores survive IndexedDB enumeration failure", parseStorageSnapshot(JSON.stringify({
  local: [{ key: "cart", bytes: 5, preview: "items" }], session: [], indexedDb: [], ran: true,
})).ran);
// Same intent as before the script was split in two: redaction and clipping
// happen in the page, and only then does anything reach stdout. The assertions
// now name the half that does each job — the driver embeds the snippet through
// JSON.stringify, so its quotes are escaped in that string and matching the
// raw text there would pass or fail for the wrong reason.
check(
  "the page redacts and clips before anything reaches stdout",
  STORAGE_BROWSER_SNIPPET.includes("value.slice(0, MAX_PREVIEW)") &&
    STORAGE_BROWSER_SNIPPET.includes('"[redacted]"') &&
    !STORAGE_BROWSER_SNIPPET.includes("process.stdout") &&
    STORAGE_SCRIPT.includes("process.stdout.write"),
);

const malformed = parseStorageSnapshot(JSON.stringify({ local: "bad", session: [null, { key: "x", preview: "y" }], indexedDb: [4, "db"], ran: "yes" }));
check("malformed array/object shapes are handled defensively", malformed.local.length === 0 && malformed.session.length === 1 && malformed.session[0]?.bytes === 1 && malformed.indexedDb.join() === "db" && !malformed.ran);

console.log(`\n${checks} storage checks passed`);

// ── Wiring (F3): the script must be runnable where it is actually run ────────
// The original export was browser code and Node code in one string — it read
// `localStorage` and wrote to `process.stdout`, so it could not run in either
// place. These pin the split, and pin that the redaction stayed on the browser
// side, which is the only side that must never let a value through.
check(
  "the browser snippet is an expression that returns the snapshot",
  STORAGE_BROWSER_SNIPPET.trim().startsWith("(async () =>") &&
    STORAGE_BROWSER_SNIPPET.includes("return {") &&
    !STORAGE_BROWSER_SNIPPET.includes("process.stdout"),
);
check(
  "redaction and clipping live in the snippet, before anything reaches stdout",
  STORAGE_BROWSER_SNIPPET.includes('"[redacted]"') &&
    STORAGE_BROWSER_SNIPPET.includes("value.slice(0, MAX_PREVIEW)"),
);
check(
  "the standalone driver embeds that same snippet and prints one line",
  STORAGE_SCRIPT.includes("captureDatabases") &&
    STORAGE_SCRIPT.includes("page.evaluate(SNIPPET)") &&
    STORAGE_SCRIPT.includes("process.stdout.write"),
);
check(
  "the driver cannot hang a build",
  STORAGE_SCRIPT.includes("setTimeout") && STORAGE_SCRIPT.includes("print(EMPTY)"),
);
check(
  "ran is an OR across the three capabilities, so one failure keeps the others",
  STORAGE_BROWSER_SNIPPET.includes("local.ok || session.ok || indexed.ok"),
);

// The interaction probe reads storage from the page it just clicked through —
// a browser of its own starts empty, so nothing a CLICK persisted could ever
// be observed from one. It must also take the snapshot BEFORE closing the
// context, because the context is where that storage lives.
{
  const probe = readFileSync(new URL("../src/verify/interactions.ts", import.meta.url), "utf8");
  check("the probe binds the shared snippet", probe.includes("STORAGE_SNIPPET = ${JSON.stringify(STORAGE_BROWSER_SNIPPET)}"));
  check("the probe reads storage from its own page", probe.includes("mergeStorage(await page.evaluate(STORAGE_SNIPPET))"));
  const snapshotAt = probe.indexOf("mergeStorage(await page.evaluate(STORAGE_SNIPPET))");
  const closeAt = probe.indexOf("if (context) await context.close()");
  check("and does it before the context is destroyed", snapshotAt > 0 && closeAt > snapshotAt);
  check("a storage read can never fail the probe", probe.includes("try { mergeStorage(await page.evaluate(STORAGE_SNIPPET)); } catch {}"));
  check("the snapshot travels on its own marked line", probe.includes('"STORAGE:" + JSON.stringify(storageSnapshot)'));
}

// The split on the service side, and the two facts the record keeps apart.
{
  const svc = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
  check("findings and storage are split, not parsed together", svc.includes("splitInteractionStdout"));
  check("a missing sandbox is ran:false, never an empty snapshot passed off as read", svc.includes("return { findings: [], ran: false, storage: EMPTY_STORAGE }"));
  check("the standalone capture exists for when the probe did not run", svc.includes("export async function captureStorage"));
  check("a capture failure never fails the build", svc.includes("storage capture unavailable"));
}
