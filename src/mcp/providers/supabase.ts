import { httpCall } from "../http.js";
import { McpError, type IProvider, type IntegrationCredentials } from "../types.js";

const MGMT_BASE = "https://api.supabase.com/v1";

export class SupabaseProvider implements IProvider {
  readonly name = "supabase" as const;

  async testConnection(
    creds: IntegrationCredentials,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string | undefined }> {
    const token = creds.token ?? creds.apiKey;
    if (!token) return { ok: false, latencyMs: 0, detail: "No token provided" };

    const t0 = Date.now();
    try {
      const res = await httpCall(`${MGMT_BASE}/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.data as unknown[];
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: `${data.length} project(s) accessible`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        detail: err instanceof McpError ? err.message : "Unknown error",
      };
    }
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const token = creds.token ?? creds.apiKey;
    if (!token) throw new McpError("AUTH_FAILED", "No Supabase token in credentials");
    const ref = (args["projectRef"] as string | undefined) ?? creds.projectRef;
    if (!ref && toolName !== "getProjects") {
      throw new McpError("PROVIDER_ERROR", "projectRef required for Supabase tools");
    }
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    switch (toolName) {
      case "pushMigrations": return this.pushMigrations(ref!, args, auth);
      case "applyRLS":       return this.applyRLS(ref!, args, auth);
      case "getConfig":      return this.getConfig(ref!, auth);
      case "getProjects":    return this.getProjects(auth);
      default: throw new McpError("TOOL_NOT_FOUND", `Unknown Supabase tool: ${toolName}`);
    }
  }

  private async pushMigrations(
    ref: string,
    args: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const sql = (args["sql"] as string | undefined) ?? "";
    const res = await httpCall(`${MGMT_BASE}/projects/${ref}/database/query`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ query: sql }),
    });
    const data = res.data as { rows?: unknown[]; error?: string };
    if (data.error) throw new McpError("PROVIDER_ERROR", `SQL error: ${data.error}`);
    return { rows: (data.rows ?? []).length, applied: true };
  }

  private async applyRLS(
    ref: string,
    args: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const sql = (args["sql"] as string | undefined) ?? "";
    const res = await httpCall(`${MGMT_BASE}/projects/${ref}/database/query`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ query: sql }),
    });
    const data = res.data as { error?: string };
    if (data.error) throw new McpError("PROVIDER_ERROR", `RLS error: ${data.error}`);
    return { applied: true };
  }

  private async getConfig(
    ref: string,
    auth: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await httpCall(`${MGMT_BASE}/projects/${ref}`, { headers: auth });
    const data = res.data as { id?: string; name?: string; region?: string; status?: string };
    return {
      id: data.id ?? ref,
      name: data.name ?? "",
      region: data.region ?? "",
      status: data.status ?? "ACTIVE_HEALTHY",
    };
  }

  private async getProjects(auth: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await httpCall(`${MGMT_BASE}/projects`, { headers: auth });
    const data = res.data as Array<{ id?: string; name?: string }>;
    return { projects: data.map((p) => ({ id: p.id ?? "", name: p.name ?? "" })) };
  }

  cliCommands(toolName: string, args: Record<string, unknown>): string[] {
    const ref = (args["projectRef"] as string | undefined) ?? "<project-ref>";
    switch (toolName) {
      case "pushMigrations": {
        return [
          `# Save the SQL to a file first:`,
          `cat > migration.sql << 'ENDSQL'\n${(args["sql"] as string | undefined) ?? "-- SQL here"}\nENDSQL`,
          `supabase db execute --project-ref ${ref} --file migration.sql`,
        ];
      }
      case "applyRLS": {
        return [
          `cat > rls.sql << 'ENDSQL'\n${(args["sql"] as string | undefined) ?? "-- RLS SQL here"}\nENDSQL`,
          `supabase db execute --project-ref ${ref} --file rls.sql`,
        ];
      }
      case "getConfig":
        return [`supabase projects list`, `supabase status --project-ref ${ref}`];
      default:
        return [`# Unknown Supabase tool: ${toolName}`];
    }
  }
}
