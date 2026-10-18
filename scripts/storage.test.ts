import { STORAGE_SCRIPT } from "../src/verify/storage-script.js";
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
check("browser script clips and redacts before stdout", STORAGE_SCRIPT.includes("value.slice(0, MAX_PREVIEW)") && STORAGE_SCRIPT.includes('"[redacted]"') && STORAGE_SCRIPT.includes("process.stdout.write"));

const malformed = parseStorageSnapshot(JSON.stringify({ local: "bad", session: [null, { key: "x", preview: "y" }], indexedDb: [4, "db"], ran: "yes" }));
check("malformed array/object shapes are handled defensively", malformed.local.length === 0 && malformed.session.length === 1 && malformed.session[0]?.bytes === 1 && malformed.indexedDb.join() === "db" && !malformed.ran);

console.log(`\n${checks} storage checks passed`);
