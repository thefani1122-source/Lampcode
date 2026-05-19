import { httpCall, qs } from "../http.js";
import { McpError, type IProvider, type IntegrationCredentials } from "../types.js";

const BASE = "https://api.vercel.com";

export class VercelProvider implements IProvider {
  readonly name = "vercel" as const;

  async testConnection(
    creds: IntegrationCredentials,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string | undefined }> {
    const token = creds.token ?? creds.apiKey;
    if (!token) return { ok: false, latencyMs: 0, detail: "No token provided" };

    const t0 = Date.now();
    try {
      const res = await httpCall(`${BASE}/v2/user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.data as { user?: { email?: string; username?: string } };
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: data.user?.email ?? data.user?.username,
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
    if (!token) throw new McpError("AUTH_FAILED", "No Vercel token in credentials");
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    switch (toolName) {
      case "deploy":     return this.deploy(args, auth, creds);
      case "setEnvVars": return this.setEnvVars(args, auth, creds);
      case "getDomains": return this.getDomains(args, auth, creds);
      case "rollback":   return this.rollback(args, auth, creds);
      default: throw new McpError("TOOL_NOT_FOUND", `Unknown Vercel tool: ${toolName}`);
    }
  }

  private async deploy(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const q = qs({ teamId: creds.teamId });
    const body = {
      name: (args["projectName"] as string | undefined) ?? "buildforge-app",
      target: "production",
      ...(args["framework"] !== undefined ? { framework: args["framework"] } : {}),
      ...(args["gitSource"] !== undefined ? { gitSource: args["gitSource"] } : {}),
    };
    const res = await httpCall(`${BASE}/v13/deployments${q}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    const data = res.data as { id?: string; url?: string; readyState?: string };
    return {
      deploymentId: data.id ?? "",
      url: data.url ? `https://${data.url}` : "",
      state: data.readyState ?? "QUEUED",
    };
  }

  private async setEnvVars(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const projectName = (args["projectName"] as string | undefined) ?? "";
    const envVars = (args["envVars"] as Record<string, string> | undefined) ?? {};
    const q = qs({ teamId: creds.teamId });

    const body = Object.entries(envVars).map(([key, value]) => ({
      key,
      value,
      target: ["production", "preview", "development"],
      type: "plain",
    }));

    const res = await httpCall(`${BASE}/v10/projects/${encodeURIComponent(projectName)}/env${q}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    const data = res.data as { created?: unknown[] };
    return { added: (data.created ?? []).length };
  }

  private async getDomains(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const projectName = (args["projectName"] as string | undefined) ?? "";
    const q = qs({ teamId: creds.teamId });
    const res = await httpCall(
      `${BASE}/v9/projects/${encodeURIComponent(projectName)}/domains${q}`,
      { headers: { Authorization: auth["Authorization"] ?? "" } },
    );
    const data = res.data as { domains?: Array<{ name?: string; verified?: boolean }> };
    return { domains: data.domains ?? [] };
  }

  private async rollback(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const projectName = (args["projectName"] as string | undefined) ?? "";
    const deploymentId = (args["deploymentId"] as string | undefined) ?? "";
    const q = qs({ teamId: creds.teamId });
    const res = await httpCall(
      `${BASE}/v13/projects/${encodeURIComponent(projectName)}/rollback/${deploymentId}${q}`,
      { method: "POST", headers: auth, body: "{}" },
    );
    const data = res.data as { status?: string };
    return { status: data.status ?? "INITIATED" };
  }

  cliCommands(toolName: string, args: Record<string, unknown>): string[] {
    switch (toolName) {
      case "deploy": {
        const name = (args["projectName"] as string | undefined) ?? "my-app";
        return [`vercel --yes --name ${name}`, "vercel --prod"];
      }
      case "setEnvVars": {
        const vars = (args["envVars"] as Record<string, string> | undefined) ?? {};
        return Object.entries(vars).map(
          ([k, v]) => `vercel env add ${k} production <<< '${v}'`,
        );
      }
      case "getDomains":
        return ["vercel domains ls"];
      case "rollback": {
        const id = (args["deploymentId"] as string | undefined) ?? "";
        return [`vercel rollback ${id}`];
      }
      default:
        return [`# Unknown Vercel tool: ${toolName}`];
    }
  }
}
