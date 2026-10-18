import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../server/logger.js";

// ── Supabase hosted MCP server ───────────────────────────────────────────────
// Official remote MCP: https://supabase.com/docs/guides/getting-started/mcp
// Auth (programmatic): a Supabase Personal Access Token (PAT) sent as
//   Authorization: Bearer <token>
// Scope to one project with ?project_ref=<ref>. We default to read-only=false
// only where we actually need to write (schema apply); reads use read_only.
const SUPABASE_MCP_URL = "https://mcp.supabase.com/mcp";

export interface SupabaseMcpAuth {
  accessToken: string; // Supabase Personal Access Token (PAT) — NEVER logged / sent to client/LLM/sandbox
  projectRef?: string | undefined;
}

function buildUrl(projectRef?: string, readOnly = false): URL {
  const url = new URL(SUPABASE_MCP_URL);
  if (projectRef) url.searchParams.set("project_ref", projectRef);
  if (readOnly) url.searchParams.set("read_only", "true");
  return url;
}

/**
 * Opens an MCP session to the Supabase server, runs `fn`, and always closes the
 * transport afterwards. The PAT is passed only as a request header — it never
 * touches logs, the client, the model context, or the sandbox.
 */
async function withSupabaseMcp<T>(
  auth: SupabaseMcpAuth,
  readOnly: boolean,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(buildUrl(auth.projectRef, readOnly), {
    requestInit: {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    },
  });
  const client = new Client({ name: "lampcode", version: "1.0.0" }, { capabilities: {} });
  try {
    // Cast: the SDK's Transport interface trips exactOptionalPropertyTypes; the
    // concrete StreamableHTTPClientTransport is a valid Transport at runtime.
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

/** Extracts the concatenated text content from an MCP tool result. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/**
 * Connects and lists the available tools. Used by the "test connection"
 * endpoint so a user can verify their PAT works against the public MCP server.
 */
export async function listSupabaseMcpTools(
  auth: SupabaseMcpAuth,
): Promise<{ name: string; description: string }[]> {
  return withSupabaseMcp(auth, true, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  });
}

/**
 * Fetches the project's public API URL + anon (publishable) key via MCP, so the
 * preview can point a generated app at the USER'S own Supabase project. The anon
 * key is public/RLS-safe; the service key and PAT never leave the backend.
 */
export async function fetchSupabaseProjectCreds(
  auth: SupabaseMcpAuth,
): Promise<{ url: string | null; anonKey: string | null }> {
  return withSupabaseMcp(auth, true, async (client) => {
    const args = auth.projectRef ? { project_id: auth.projectRef } : {};

    let lastUrlResult: unknown = null;
    let lastKeysResult: unknown = null;

    let url: string | null = null;
    try {
      const r = await client.callTool({ name: "get_project_url", arguments: args });
      lastUrlResult = r;
      url = extractProjectUrl(payloadOf(r));
    } catch (err) {
      logger.warn({ err }, "[mcp] get_project_url failed");
    }

    let anonKey: string | null = null;
    try {
      const r = await client.callTool({ name: "get_publishable_keys", arguments: args });
      lastKeysResult = r;
      anonKey = extractAnonKey(payloadOf(r));
    } catch (err) {
      logger.warn({ err }, "[mcp] get_publishable_keys failed");
    }

    if (!url || !anonKey) {
      // The SHAPE, never the values — and enough of it that a third failure
      // does not cost another guess. Two deployments were spent asking "is it
      // in content, or in structuredContent?" when the result itself could
      // have said so the first time. Key names and types only: a Supabase PAT
      // and an anon key must never reach a log line.
      logger.warn(
        {
          hasUrl: Boolean(url),
          hasAnonKey: Boolean(anonKey),
          urlShape: describeShape(lastUrlResult),
          keysShape: describeShape(lastKeysResult),
        },
        "[mcp] project creds incomplete",
      );
    }
    return { url, anonKey };
  });
}

/**
 * The payload of an MCP tool result, from wherever this server put it.
 *
 * MEASURED 2026-10-18. Connecting a Supabase project failed with "the project
 * returned no URL or anon key" while BOTH tool calls succeeded and nothing was
 * logged — because the extractor read only `content[].text`, and the server
 * answers these two tools in `structuredContent`. A tool that returns nothing
 * and a tool that returns somewhere else look identical from one field.
 *
 * So both are read, and the caller gets the parsed object AND the raw text: a
 * server that returns a bare string and one that returns JSON both work, and a
 * third shape later degrades to the regex rather than to silence.
 */
function payloadOf(result: unknown): { text: string; data: unknown } {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
  const text = textOf({ content: r.content ?? [] });
  let data: unknown = r.structuredContent ?? null;
  if (data === null && text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* a plain string is a valid answer too */
    }
  }
  // The whole result, serialised. Read `raw` for why this is here.
  let raw = "";
  try {
    raw = JSON.stringify(result) ?? "";
  } catch {
    /* circular or otherwise unserialisable — the fields above still apply */
  }
  return { text: text || raw, data };
}

/**
 * Everything above is the tidy path: named fields, in the places a server is
 * expected to put them. `payloadOf` falls back to the ENTIRE serialised result
 * as its text, and that is deliberate.
 *
 * MEASURED 2026-10-18, twice. First `content[].text` was read and the answer
 * was not there. Then `structuredContent` was added — and the answer was not
 * there either: four more attempts, `hasUrl=false hasAnonKey=false`, and still
 * not one error, because the calls kept succeeding. Two guesses at a schema,
 * two deployments, two rounds of the owner retrying by hand.
 *
 * So the third attempt stops guessing where. The three values this function
 * needs have shapes nothing else has — `https://<ref>.supabase.co`, a JWT
 * beginning `eyJ`, and `sb_publishable_…` — and a value that distinctive can
 * be found by what it IS rather than by where it sits. Knowing the schema is
 * nicer; working whatever the schema turns out to be is worth more here, and
 * the structured path is still tried first so a well-formed answer is read
 * properly rather than scraped.
 */


/**
 * A result's structure, with every value removed.
 *
 * A Supabase PAT and an anon key must never reach a log line, and "log the
 * response so we can see it" is how they do. This prints key names, types and
 * array lengths — enough to find where an answer lives, and nothing that is
 * worth stealing.
 */
function describeShape(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) {
    return depth >= 3 ? `array(${v.length})` : `[${v.length}: ${describeShape(v[0], depth + 1)}]`;
  }
  if (typeof v === "object") {
    if (depth >= 3) return "object";
    const keys = Object.keys(v as object).slice(0, 12);
    return `{${keys.map((k) => `${k}:${describeShape((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  return typeof v === "string" ? `string(${v.length})` : typeof v;
}

function extractProjectUrl({ text, data }: { text: string; data: unknown }): string | null {
  if (data && typeof data === "object") {
    const u = (data as Record<string, unknown>)["url"] ?? (data as Record<string, unknown>)["project_url"];
    if (typeof u === "string" && u.startsWith("http")) return u;
  }
  // A bare URL, or one embedded in prose.
  const m = text.match(/https:\/\/[a-z0-9-]+\.supabase\.co/i);
  return m ? m[0] : null;
}

/**
 * The key a generated app should initialise its Supabase client with.
 *
 * The server answers `get_publishable_keys` with a LIST — measured shape:
 * `{ keys: [ { api_key, name, type, disabled, id }, … ] }`, carrying both the
 * legacy JWT anon key and a modern `sb_publishable_…` one.
 *
 * The legacy anon key is preferred, and that is a decision rather than
 * nostalgia: everything the prompt teaches about `auth.uid()` and the JWT the
 * backend forwards is built on it, and it is what a model has seen a million
 * times. The publishable key is the fallback, so a project that has retired the
 * legacy key still connects.
 *
 * Disabled keys are skipped. Handing out a key that will be refused is the same
 * class of bug as this whole function had: a confident answer that does not work.
 */
export function extractAnonKey({ text, data }: { text: string; data: unknown }): string | null {
  const rows: Array<Record<string, unknown>> = [];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const list = Array.isArray(d["keys"]) ? (d["keys"] as unknown[]) : Array.isArray(data) ? (data as unknown[]) : [];
    for (const k of list) if (k && typeof k === "object") rows.push(k as Record<string, unknown>);

    // Single-object shapes, kept from the previous implementation.
    const direct = d["anon_key"] ?? d["anonKey"] ?? d["publishable_key"] ?? d["key"];
    if (typeof direct === "string" && direct.length > 0) return direct;
  }

  const usable = rows.filter((k) => k["disabled"] !== true && typeof k["api_key"] === "string");
  const legacy = usable.find((k) => String(k["api_key"]).startsWith("eyJ"));
  if (legacy) return String(legacy["api_key"]);
  const publishable = usable.find((k) => String(k["api_key"]).startsWith("sb_publishable_"));
  if (publishable) return String(publishable["api_key"]);
  if (usable[0]) return String(usable[0]["api_key"]);

  // Last resort: the key sitting in prose, which is how this used to work.
  const jwt = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwt) return jwt[0];
  const pub = text.match(/sb_publishable_[A-Za-z0-9_-]+/);
  return pub ? pub[0] : null;
}

/**
 * Runs the generated schema SQL against the user's project as a named migration.
 * This is how "add login / a tasks table" actually provisions the user's DB.
 */
export async function applySupabaseSchema(
  auth: SupabaseMcpAuth,
  name: string,
  sql: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!sql.trim()) return { ok: true, error: null };
  try {
    return await withSupabaseMcp(auth, false, async (client) => {
      const r = await client.callTool({
        name: "apply_migration",
        arguments: {
          ...(auth.projectRef ? { project_id: auth.projectRef } : {}),
          name,
          query: sql,
        },
      });
      const res = r as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      if (res.isError) return { ok: false, error: textOf(res) || "migration failed" };
      return { ok: true, error: null };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[mcp] apply_migration failed");
    return { ok: false, error: msg };
  }
}
