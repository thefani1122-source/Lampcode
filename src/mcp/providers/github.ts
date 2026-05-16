import { httpCall } from "../http.js";
import { McpError, type IProvider, type IntegrationCredentials } from "../types.js";

const BASE = "https://api.github.com";

export class GithubProvider implements IProvider {
  readonly name = "github" as const;

  async testConnection(
    creds: IntegrationCredentials,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string | undefined }> {
    const token = creds.token ?? creds.apiKey;
    if (!token) return { ok: false, latencyMs: 0, detail: "No token provided" };

    const t0 = Date.now();
    try {
      const res = await httpCall(`${BASE}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      const data = res.data as { login?: string; email?: string };
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: data.login,
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
    if (!token) throw new McpError("AUTH_FAILED", "No GitHub token in credentials");
    const auth = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    switch (toolName) {
      case "createRepo": return this.createRepo(args, auth, creds);
      case "pushCode":   return this.pushCode(args, auth, creds);
      case "createPR":   return this.createPR(args, auth, creds);
      default: throw new McpError("TOOL_NOT_FOUND", `Unknown GitHub tool: ${toolName}`);
    }
  }

  private async createRepo(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const name = (args["name"] as string | undefined) ?? "buildforge-repo";
    const isPrivate = (args["private"] as boolean | undefined) ?? true;
    const org = (args["org"] as string | undefined) ?? creds.orgId;

    const endpoint = org ? `${BASE}/orgs/${encodeURIComponent(org)}/repos` : `${BASE}/user/repos`;
    const res = await httpCall(endpoint, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        private: isPrivate,
        auto_init: true,
        description: (args["description"] as string | undefined) ?? "Created by BuildForge",
      }),
    });
    const data = res.data as { full_name?: string; html_url?: string; clone_url?: string; default_branch?: string };
    return {
      fullName: data.full_name ?? "",
      htmlUrl: data.html_url ?? "",
      cloneUrl: data.clone_url ?? "",
      defaultBranch: data.default_branch ?? "main",
    };
  }

  private async pushCode(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const repo = (args["repo"] as string | undefined) ?? "";
    const branch = (args["branch"] as string | undefined) ?? "main";
    const message = (args["message"] as string | undefined) ?? "chore: deploy from BuildForge";
    const owner = (args["owner"] as string | undefined) ?? creds.repoOwner ?? "";
    const files = (args["files"] as Array<{ path: string; content: string }> | undefined) ?? [];

    // Upload files via GitHub Contents API
    let pushed = 0;
    for (const file of files) {
      const content = Buffer.from(file.content, "utf8").toString("base64");
      // Try to get existing file SHA for update
      let sha: string | undefined;
      try {
        const existing = await httpCall(
          `${BASE}/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
          { headers: auth },
        );
        const existingData = existing.data as { sha?: string };
        sha = existingData.sha;
      } catch {
        // File doesn't exist yet — create it
      }

      await httpCall(`${BASE}/repos/${owner}/${repo}/contents/${file.path}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          message: `${message} (${file.path})`,
          content,
          branch,
          ...(sha !== undefined ? { sha } : {}),
        }),
      });
      pushed++;
    }
    return { pushed, repo: `${owner}/${repo}`, branch };
  }

  private async createPR(
    args: Record<string, unknown>,
    auth: Record<string, string>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>> {
    const repo = (args["repo"] as string | undefined) ?? "";
    const owner = (args["owner"] as string | undefined) ?? creds.repoOwner ?? "";
    const head = (args["head"] as string | undefined) ?? "main";
    const base = (args["base"] as string | undefined) ?? "main";
    const title = (args["title"] as string | undefined) ?? "BuildForge deploy";
    const body = (args["body"] as string | undefined) ?? "";

    const res = await httpCall(`${BASE}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title, body, head, base }),
    });
    const data = res.data as { number?: number; html_url?: string; state?: string };
    return { number: data.number ?? 0, htmlUrl: data.html_url ?? "", state: data.state ?? "open" };
  }

  cliCommands(toolName: string, args: Record<string, unknown>): string[] {
    switch (toolName) {
      case "createRepo": {
        const name = (args["name"] as string | undefined) ?? "my-repo";
        const org = args["org"] as string | undefined;
        const visibility = args["private"] ? "--private" : "--public";
        return org
          ? [`gh repo create ${org}/${name} ${visibility} --clone`]
          : [`gh repo create ${name} ${visibility} --clone`];
      }
      case "pushCode": {
        const repo = (args["repo"] as string | undefined) ?? "repo";
        const branch = (args["branch"] as string | undefined) ?? "main";
        const msg = (args["message"] as string | undefined) ?? "chore: deploy";
        return [
          `git add -A`,
          `git commit -m '${msg}'`,
          `git remote add origin git@github.com:${args["owner"] ?? "owner"}/${repo}.git 2>/dev/null || true`,
          `git push -u origin ${branch}`,
        ];
      }
      case "createPR": {
        const title = (args["title"] as string | undefined) ?? "BuildForge deploy";
        const base = (args["base"] as string | undefined) ?? "main";
        return [`gh pr create --title '${title}' --body '' --base ${base}`];
      }
      default:
        return [`# Unknown GitHub tool: ${toolName}`];
    }
  }
}
