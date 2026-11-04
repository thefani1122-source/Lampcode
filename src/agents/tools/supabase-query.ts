import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { credsFor, notConnected, truncate } from "./rest-queries.js";
import { callSupabaseMcpTool, listSupabaseMcpTools, type SupabaseMcpAuth } from "../../mcp/supabase-mcp.js";

/**
 * Read-only Supabase lookups through the user's own hosted Supabase MCP
 * server (a Personal Access Token, already verified at connect time). Every
 * call runs on a read_only MCP session: SQL never mutates anything here, and
 * writes on the user's database stay behind request_write_action by design.
 * The PAT travels only as a request header — never into the model context.
 */

function authFrom(ctx: ToolExecutionContext): SupabaseMcpAuth | null {
  const creds = credsFor(ctx, "supabase");
  const token = creds?.["accessToken"]?.trim() ?? creds?.["access_token"]?.trim() ?? creds?.["supabase_pat"]?.trim() ?? creds?.["oauth_access_token"]?.trim();
  if (!token) return null;
  return { accessToken: token, projectRef: creds?.["projectRef"]?.trim() || undefined };
}

const LOG_SERVICES = ["api", "db", "auth", "storage", "edge", "realtime"] as const;

export const supabaseQueryHandler: ToolHandler = async (args, ctx) => {
  const auth = authFrom(ctx);
  if (!auth) {
    return notConnected(
      "Supabase",
      "(a Supabase Personal Access Token, or connect Supabase with one-click OAuth — both live in the Integrations store).",
    );
  }

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_tables";

  try {
    if (action === "list_tables" || !action) {
      const schemas = typeof args["schema"] === "string" && args["schema"].trim() ? [args["schema"].trim()] : ["public"];
      const { text, data } = await callSupabaseMcpTool(auth, "list_tables", { schemas }, true);
      if (!text) return `Supabase returned no table data (schema: ${schemas.join(", ")}).`;
      void data;
      return `Supabase tables (schema: ${schemas.join(", ")}):\n${truncate(text, 6000)}`;
    }

    if (action === "run_sql") {
      const query = String(args["query"] ?? "").trim();
      if (!query) return "Error: a SQL `query` is required for run_sql (SELECT only — this session is read-only).";
      if (!/^\s*(select|with|explain|show|table)\b/i.test(query)) {
        return (
          "Error: run_sql only accepts read-only statements (SELECT / WITH / EXPLAIN / SHOW / TABLE). " +
          "Writes go through the write-approval flow, not this tool."
        );
      }
      const { text } = await callSupabaseMcpTool(auth, "execute_sql", { query }, true);
      return text ? `SQL result:\n${truncate(text, 6000)}` : "The query ran but returned no rows.";
    }

    if (action === "get_logs") {
      const service = String(args["service"] ?? "api").toLowerCase();
      if (!(LOG_SERVICES as readonly string[]).includes(service)) {
        return `Error: \`service\` must be one of ${LOG_SERVICES.join(", ")}.`;
      }
      const minutes = Math.min(Math.max(Number(args["minutes"] ?? 60) || 60, 1), 1440);
      const { text } = await callSupabaseMcpTool(
        auth,
        "get_logs",
        { service, log_count: 50, age_minutes: minutes },
        true,
      );
      return text ? `Supabase ${service} logs (last ${minutes} min):\n${truncate(text, 6000)}` : `No ${service} log entries in the last ${minutes} minutes.`;
    }

    if (action === "get_advisors") {
      const type = String(args["advisors_type"] ?? "security").toLowerCase();
      if (type !== "security" && type !== "performance") {
        return "Error: `advisors_type` must be `security` or `performance`.";
      }
      const { text } = await callSupabaseMcpTool(auth, "get_advisors", { type }, true);
      return text ? `Supabase ${type} advisors:\n${truncate(text, 6000)}` : `No ${type} advisors findings.`;
    }

    if (action === "list_edge_functions") {
      const { text } = await callSupabaseMcpTool(auth, "list_edge_functions", {}, true);
      return text ? `Supabase edge functions:\n${truncate(text, 4000)}` : "No edge functions in this project.";
    }

    // Unknown action — report what the server actually offers instead of guessing.
    const tools = await listSupabaseMcpTools(auth);
    const names = tools.map((t) => t.name).join(", ");
    return `Unknown action "${action}". This Supabase connection supports the MCP tools: ${names || "(none listed)"}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Supabase MCP error: ${message}. If the token expired or the project was paused, reconnect Supabase in the Integrations store.`;
  }
};
