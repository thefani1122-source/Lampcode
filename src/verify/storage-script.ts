/**
 * Browser-side storage inventory. Values are redacted or clipped before the
 * single JSON line reaches command output.
 */
export const STORAGE_SCRIPT = String.raw`
const MAX_PREVIEW = 80;
const SECRET_KEY = /token|secret|key|password|jwt|session/i;
let printed = false;
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
function print(snapshot) {
  if (printed) return;
  printed = true;
  process.stdout.write(JSON.stringify(snapshot) + "\n");
}
(async () => {
  const local = captureStore(() => localStorage);
  const session = captureStore(() => sessionStorage);
  const indexed = await captureDatabases();
  print({
    local: local.entries,
    session: session.entries,
    indexedDb: indexed.names,
    ran: local.ok || session.ok || indexed.ok,
  });
})().catch(() => print({ local: [], session: [], indexedDb: [], ran: false }));
`;
