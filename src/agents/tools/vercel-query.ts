import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Read-only lookups on the user's connected Vercel account: deployments,
 * projects, deployment details, build logs and runtime logs. Writes
 * (rollback, cancel) live in vercel-writes.ts behind the shared write
 * approval gate — this file never mutates anything.
 */

export const vercelQueryHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  const token = ctx.deploy?.vercelToken;
  if (!token) {
    // "Not connected" and "connected but tokenless" are different truths. The
    // 2026-11-04 failure had the OAuth connection stored while no REST token
    // could be resolved from it — reporting plain "not connected" told the
    // user to connect something that was already connected.
    const vercelRow = ctx.connectedServices?.find((s) => s.slug === "vercel");
    if (vercelRow) {
      return (
        "Vercel IS connected (OAuth), but no account token could be resolved from the stored " +
        "connection, so queries and deployments cannot run. Reconnect Vercel in Integrations " +
        "settings to refresh its token, then ask again."
      );
    }
    return "Vercel is not connected. Please connect Vercel in Integrations settings with your Vercel Access Token.";
  }

  const teamId = ctx.deploy?.teamId;
  const qs = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";
  const joinQ = (extra: string): string => [qs, extra].filter(Boolean).join("&");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // A rejected credential is a sentence, not a stack: 401 means the stored
  // token is expired or MCP-scoped, and the fix is a reconnect (or an account
  // Access Token) in the Integrations store.
  const guard = async (res: Response): Promise<string | null> => {
    if (res.status !== 401 && res.status !== 403) return null;
    return (
      "Vercel rejected the stored credential (HTTP " + res.status + "). " +
      "The Vercel connection needs to be reconnected in Integrations settings — " +
      "reconnect it, or add a Vercel Access Token to the Vercel integration, then ask again."
    );
  };

  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const action = (typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "") || "list_deployments";

  try {
    if (action === "list_deployments") {
      const project = str("project");
      const query = joinQ("limit=10" + (project ? `&project=${encodeURIComponent(project)}` : ""));
      const res = await fetch(`https://api.vercel.com/v6/deployments?${query}`, { headers });
      const rejected = await guard(res);
      if (rejected) return rejected;
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { deployments?: Array<Record<string, unknown>> };
      const deps = data.deployments ?? [];
      if (deps.length === 0) return "No deployments found in this Vercel account.";
      const formatted = deps.map((d, i) => {
        const name = String(d["name"] ?? "");
        const url = String(d["url"] ?? "");
        const state = String(d["state"] ?? d["readyState"] ?? "UNKNOWN");
        const created = d["created"] ? new Date(Number(d["created"])).toISOString().slice(0, 10) : "";
        const target = String(d["target"] ?? "");
        return `${i + 1}. **${name}** — State: \`${state}\`${target ? ` — target: ${target}` : ""} — URL: https://${url} (${created}) — id: \`${String(d["uid"] ?? d["id"] ?? "")}\``;
      });
      return `Recent Vercel deployments:\n\n${formatted.join("\n")}`;
    }

    if (action === "list_projects") {
      const res = await fetch(`https://api.vercel.com/v9/projects?${joinQ("limit=10")}`, { headers });
      const rejected = await guard(res);
      if (rejected) return rejected;
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { projects?: Array<Record<string, unknown>> };
      const projs = data.projects ?? [];
      if (projs.length === 0) return "No projects found in this Vercel account.";
      const formatted = projs.map((p, i) => {
        const name = String(p["name"] ?? "");
        const fw = String(p["framework"] ?? "custom");
        const latest = (p["latestDeployments"] as Array<Record<string, unknown>> | undefined)?.[0];
        const state = latest ? String(latest["readyState"] ?? "") : "";
        return `${i + 1}. **${name}** (Framework: ${fw}${state ? `, latest deploy: ${state}` : ""}) — id: \`${String(p["id"] ?? "")}\``;
      });
      return `Vercel projects:\n\n${formatted.join("\n")}`;
    }

    if (action === "get_deployment") {
      const id = str("deployment");
      if (!id) return "Error: a `deployment` id or URL is required (list_deployments prints ids).";
      const res = await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, { headers });
      const rejected = await guard(res);
      if (rejected) return rejected;
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const d = (await res.json()) as Record<string, unknown>;
      const meta = (d["meta"] ?? {}) as Record<string, unknown>;
      const lines = [
        `Deployment **${String(d["name"] ?? "")}** — id \`${String(d["uid"] ?? d["id"] ?? id)}\``,
        `- State: \`${String(d["readyState"] ?? d["state"] ?? "UNKNOWN")}\`${d["target"] ? ` (target: ${String(d["target"])})` : ""}`,
        `- URL: https://${String(d["url"] ?? "")}`,
        `- Project: ${String(d["projectId"] ?? "")}, created ${d["created"] ? new Date(Number(d["created"])).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "unknown"}`,
        ...(meta["githubCommitRef"] ? [`- Branch: ${String(meta["githubCommitRef"])}, commit ${String(meta["githubCommitSha"] ?? "").slice(0, 7)}: ${String(meta["githubCommitMessage"] ?? "")}`] : []),
        ...(d["errorMessage"] ? [`- ⚠️ Error: ${String(d["errorMessage"])}`] : []),
      ];
      return lines.join("\n");
    }

    if (action === "get_deployment_logs") {
      // Build logs come from the deployment events endpoint. With `limit` set
      // it answers with a JSON array; without, it streams NDJSON — both are
      // handled here because Vercel has historically varied by plan and API
      // version.
      const id = str("deployment");
      if (!id) return "Error: a `deployment` id or URL is required (list_deployments prints ids).";
      const res = await fetch(
        `https://api.vercel.com/v3/deployments/${encodeURIComponent(id)}/events?${joinQ("limit=120&builds=1&direction=backward")}`,
        { headers },
      );
      const rejected = await guard(res);
      if (rejected) return rejected;
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const raw = await res.text();
      const messages: string[] = [];
      const collect = (event: Record<string, unknown>) => {
        const payload = (event["payload"] ?? {}) as Record<string, unknown>;
        const text = String(payload["text"] ?? event["text"] ?? "").trim();
        if (text) messages.push(text);
      };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const event of parsed) collect(event as Record<string, unknown>);
        } else if (parsed && typeof parsed === "object") {
          collect(parsed as Record<string, unknown>);
        }
      } catch {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            collect(JSON.parse(trimmed) as Record<string, unknown>);
          } catch { /* a non-JSON line is a plain log line */ messages.push(trimmed); }
        }
      }
      if (messages.length === 0) return "No build log lines were returned for this deployment.";
      const shown = messages.slice(0, 80);
      return [
        `Build logs for \`${id}\` (showing ${shown.length} of ${messages.length} lines, newest first):`,
        "",
        ...shown.map(l => (l.length > 300 ? `${l.slice(0, 300)}…` : l)),
      ].join("\n");
    }

    if (action === "get_runtime_logs") {
      // Runtime logs live on the project-scoped endpoint and stream NDJSON.
      const id = str("deployment");
      if (!id) return "Error: a `deployment` id or URL is required (list_deployments prints ids).";
      const project = str("project") || ctx.deploy?.projectName || "";
      if (!project) return "Error: a `project` name is required for runtime logs (list_projects prints them).";
      const res = await fetch(
        `https://api.vercel.com/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}/runtime-logs${qs ? `?${qs}` : ""}`,
        { headers },
      );
      const rejected = await guard(res);
      if (rejected) return rejected;
      if (!res.ok) return `Vercel API error (${res.status}): ${await res.text()}`;
      const raw = await res.text();
      const lines: string[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const level = String(entry["level"] ?? "info");
          const message = String(entry["message"] ?? "").trim();
          if (message) lines.push(`[${level}] ${message}`);
        } catch { lines.push(trimmed); }
        if (lines.length >= 80) break;
      }
      if (lines.length === 0) return "No runtime log lines were returned for this deployment (runtime logs need the app to have served requests).";
      return [
        `Runtime logs for \`${id}\` (showing up to ${lines.length} lines):`,
        "",
        ...lines.map(l => (l.length > 300 ? `${l.slice(0, 300)}…` : l)),
      ].join("\n");
    }

    return `Unknown action "${action}". Supported vercel_query actions: list_deployments, list_projects, get_deployment, get_deployment_logs, get_runtime_logs.`;
  } catch (err) {
    return `Failed to query Vercel: ${err instanceof Error ? err.message : String(err)}`;
  }
};
