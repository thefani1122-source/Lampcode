export interface StorageEntry {
  key: string;
  bytes: number;
  preview: string;
}

export interface StorageSnapshot {
  local: StorageEntry[];
  session: StorageEntry[];
  indexedDb: string[];
  ran: boolean;
}

const EMPTY: StorageSnapshot = { local: [], session: [], indexedDb: [], ran: false };
const SECRET_KEY = /token|secret|key|password|jwt|session/i;
const MAX_PREVIEW = 80;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function entries(value: unknown): StorageEntry[] {
  if (!Array.isArray(value)) return [];
  const out: StorageEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.key !== "string" || typeof entry.preview !== "string") continue;
    const bytes = typeof entry.bytes === "number" && Number.isFinite(entry.bytes) && entry.bytes >= 0
      ? Math.floor(entry.bytes)
      : utf8Bytes(entry.preview);
    out.push({
      key: entry.key,
      bytes,
      preview: SECRET_KEY.test(entry.key) ? "[redacted]" : entry.preview.slice(0, MAX_PREVIEW),
    });
  }
  return out;
}

export function parseStorageSnapshot(raw: string): StorageSnapshot {
  if (typeof raw !== "string" || !raw.trim()) return { ...EMPTY };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
    const root = value as Record<string, unknown>;
    return {
      local: entries(root.local),
      session: entries(root.session),
      indexedDb: Array.isArray(root.indexedDb) ? root.indexedDb.filter((name): name is string => typeof name === "string") : [],
      ran: root.ran === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function formatStorage(snapshot: StorageSnapshot): string {
  const local = Array.isArray(snapshot?.local) ? snapshot.local : [];
  const session = Array.isArray(snapshot?.session) ? snapshot.session : [];
  const indexedDb = Array.isArray(snapshot?.indexedDb) ? snapshot.indexedDb : [];
  if (!local.length && !session.length && !indexedDb.length) return "No browser storage entries were captured.";
  const lines: string[] = [];
  for (const [label, values] of [["local", local], ["session", session]] as const) {
    for (const item of values) {
      lines.push(`${label} ${item.key} (${item.bytes} bytes): ${item.preview}`);
    }
  }
  for (const name of indexedDb) lines.push(`IndexedDB: ${name}`);
  return lines.join("\n");
}
