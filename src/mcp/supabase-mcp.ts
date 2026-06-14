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

    let url: string | null = null;
    try {
      const r = await client.callTool({ name: "get_project_url", arguments: args });
      url = textOf(r as never) || null;
    } catch (err) {
      logger.warn({ err }, "[mcp] get_project_url failed");
    }

    let anonKey: string | null = null;
    try {
      const r = await client.callTool({ name: "get_publishable_keys", arguments: args });
      const text = textOf(r as never);
      // Result may be a plain key or JSON ({ anon_key } / array of keys).
      anonKey = extractAnonKey(text);
    } catch (err) {
      logger.warn({ err }, "[mcp] get_publishable_keys failed");
    }

    return { url, anonKey };
  });
}

function extractAnonKey(text: string): string | null {
  if (!text) return null;
  // JWT-style anon keys start with "eyJ"; grab the first one if present.
  const jwt = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwt) return jwt[0];
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const cand = parsed.anon_key ?? parsed.anonKey ?? parsed.publishable_key ?? parsed.key;
      if (typeof cand === "string") return cand;
    }
  } catch {
    /* not JSON */
  }
  return null;
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
