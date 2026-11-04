import type { ToolDefinition } from "./../model-gateway.js";
import type { ToolExecutionContext } from "../tools.js";
import type { WriteMcpMeta } from "../mcp-tool-classifier.js";
import type { Tier } from "../../mcp/tiers.js";

/**
 * Write tools for Vercel over the stored account token — the counterpart of
 * the read-only lookups in vercel-query.ts. These are never registered in the
 * static handler registry: the ONLY path to them runs through the shared write
 * approval gate (build:write_action_approval_required) in executeTool, so the
 * user always sees what will happen before it happens.
 *
 * Rollback points production traffic at an older deployment — reversible by
 * rolling forward, but it changes what visitors see, so it is "approval".
 * Cancelling a running deployment is also "approval". Deletion of projects or
 * deployments is deliberately NOT offered — the user does that themselves in
 * the Vercel dashboard.
 */

async function vercelSend(
  url: string,
  method: "POST" | "PATCH",
  token: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text) as unknown; } catch { /* keep raw text */ }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

export const vercelWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const token = ctx.deploy?.vercelToken;
  if (!token) {
    return "Vercel is not connected. Please tell the user to connect Vercel in the Integrations store first.";
  }
  const teamId = ctx.deploy?.teamId;
  const qs = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";
  const action = str(args, "action") || "rollback";

  if (action === "rollback") {
    // POST /v1/projects/{projectId}/rollback/{deploymentId} — documented Vercel
    // REST endpoint that points production traffic at an older production
    // deployment. Project paths accept the project name as well as its id.
    const deployment = str(args, "deployment");
    if (!deployment) return "Error: a `deployment` id (or URL) is required to roll back — get one with vercel_query list_deployments.";
    const project = str(args, "project") || ctx.deploy?.projectName || "";
    if (!project) return "Error: a `project` name is required to roll back — get one with vercel_query list_projects.";
    const description = str(args, "description");
    const query = [qs, description ? `description=${encodeURIComponent(description)}` : ""].filter(Boolean).join("&");
    const { status, body } = await vercelSend(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(deployment)}${query ? `?${query}` : ""}`,
      "POST",
      token,
    );
    if (status === 401 || status === 403) {
      return `Vercel rejected the stored credential (HTTP ${status}). The Vercel connection needs to be reconnected in Integrations settings — reconnect it, or add a Vercel Access Token, then ask again. No change was made.`;
    }
    if (status !== 201 && status !== 200) return `Vercel API error (${status}): ${String(JSON.stringify(body ?? ""))}`;
    const rolled = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const target = String(rolled["url"] ?? rolled["targetUrl"] ?? deployment);
    return [
      `Rolled back production for project \`${project}\` to deployment \`${deployment}\`.`,
      `Live URL: https://${target}`,
      "Production traffic now serves that build. Rolling forward is the same call with the newer deployment id.",
    ].join("\n");
  }

  if (action === "cancel_deployment") {
    // PATCH /v12/deployments/{id}/cancel — stops a running build. Cheap and
    // reversible in the sense that a new deploy can be triggered, so it stays
    // behind the same approval gate as every other write.
    const deployment = str(args, "deployment");
    if (!deployment) return "Error: a `deployment` id is required to cancel — get one with vercel_query list_deployments.";
    const { status, body } = await vercelSend(
      `https://api.vercel.com/v12/deployments/${encodeURIComponent(deployment)}/cancel${qs ? `?${qs}` : ""}`,
      "PATCH",
      token,
    );
    if (status !== 200) return `Vercel API error (${status}): ${String(JSON.stringify(body ?? ""))}`;
    return `Cancelled deployment \`${deployment}\`. The production deployment that was live before it is untouched.`;
  }

  return `Unknown action. Supported vercel_write actions: rollback, cancel_deployment. Deleting projects or deployments is NOT offered — the user does that in the Vercel dashboard.`;
};

// ── Definition + approval-gate registry ─────────────────────────────────────

const VERCEL_WRITE_DEF: ToolDefinition = {
  name: "vercel_write",
  description:
    "Change the user's connected Vercel deployments. WRITE actions: the user is asked to approve first. " +
    "Actions: rollback (points production traffic at an older production deployment — say which deployment " +
    "you will roll back to and why before you call it), cancel_deployment (stops a running build). " +
    "Deleting projects or deployments is NOT offered — tell the user to do that in the Vercel dashboard.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["rollback", "cancel_deployment"],
        description: "Which write to perform. Default 'rollback'.",
      },
      deployment: {
        type: "string",
        description: "Deployment id or URL to roll back to, or to cancel (use vercel_query list_deployments to find ids).",
      },
      project: {
        type: "string",
        description: "Project name or id ('rollback'). Defaults to the project this app is deployed under.",
      },
      description: {
        type: "string",
        description: "Optional reason for the rollback, recorded in Vercel.",
      },
    },
    required: [],
  },
};

export const VERCEL_WRITE_DEFS: ToolDefinition[] = [VERCEL_WRITE_DEF];

export function buildVercelWriteRegistry(vercelToken?: string): Map<string, WriteMcpMeta> {
  const registry = new Map<string, WriteMcpMeta>();
  if (!vercelToken) return registry; // fail closed: no token → no write tools offered
  const tier: Tier = "approval";
  registry.set("vercel_write", {
    serverSlug: "vercel",
    serverUrl: "",
    authToken: null,
    mcpToolName: "vercel_write",
    tier,
    capability: null,
    localExecute: vercelWriteHandler,
  });
  return registry;
}
