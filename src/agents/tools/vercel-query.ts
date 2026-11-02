import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

export const vercelQueryHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  const token = ctx.deploy?.vercelToken;
  if (!token) {
    return "Vercel is not connected. Please connect Vercel in Integrations settings with your Vercel Access Token.";
  }

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_deployments";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  try {
    if (action === "list_deployments" || !action) {
      const res = await fetch("https://api.vercel.com/v6/deployments?limit=10", { headers });
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { deployments?: Array<Record<string, unknown>> };
      const deps = data.deployments ?? [];
      if (deps.length === 0) return "No deployments found in this Vercel account.";
      const formatted = deps.map((d, i) => {
        const name = String(d["name"] ?? "");
        const url = String(d["url"] ?? "");
        const state = String(d["state"] ?? d["readyState"] ?? "UNKNOWN");
        const created = d["created"] ? new Date(Number(d["created"])).toISOString().slice(0, 10) : "";
        return `${i + 1}. **${name}** — State: \`${state}\` — URL: https://${url} (${created})`;
      });
      return `Recent Vercel deployments:\n\n${formatted.join("\n")}`;
    }

    if (action === "list_projects") {
      const res = await fetch("https://api.vercel.com/v9/projects?limit=10", { headers });
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { projects?: Array<Record<string, unknown>> };
      const projs = data.projects ?? [];
      if (projs.length === 0) return "No projects found in this Vercel account.";
      const formatted = projs.map((p, i) => {
        const name = String(p["name"] ?? "");
        const fw = String(p["framework"] ?? "custom");
        return `${i + 1}. **${name}** (Framework: ${fw})`;
      });
      return `Vercel projects:\n\n${formatted.join("\n")}`;
    }

    return `Unknown action "${action}". Supported actions: list_deployments, list_projects.`;
  } catch (err) {
    return `Failed to query Vercel: ${err instanceof Error ? err.message : String(err)}`;
  }
};
