import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

export const githubQueryHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  const token = ctx.gitHubToken;
  if (!token) {
    return (
      "GitHub is not connected or no Personal Access Token was found. " +
      "Please tell the user to connect GitHub in Integrations settings with their Personal Access Token (PAT)."
    );
  }

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_repos";
  const repo = typeof args["repo"] === "string" ? args["repo"].trim() : "";
  const owner = typeof args["owner"] === "string" ? args["owner"].trim() : "";

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Lampcode-Agent/1.0",
  };

  try {
    if (action === "list_repos" || !action) {
      const res = await fetch("https://api.github.com/user/repos?per_page=30&sort=updated", { headers });
      if (!res.ok) {
        return `GitHub API error (${res.status}): ${await res.text()}`;
      }
      const data = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(data) || data.length === 0) {
        return "No repositories found for this GitHub account.";
      }
      const formatted = data.map((r, i) => {
        const fullName = String(r["full_name"] ?? r["name"] ?? "");
        const isPrivate = r["private"] ? "Private" : "Public";
        const desc = r["description"] ? ` - ${r["description"]}` : "";
        const updated = r["updated_at"] ? ` (Updated: ${String(r["updated_at"]).slice(0, 10)})` : "";
        const stars = Number(r["stargazers_count"] ?? 0);
        return `${i + 1}. **${fullName}** [${isPrivate}]${stars > 0 ? ` ⭐ ${stars}` : ""}${updated}${desc}`;
      });
      return `Found ${data.length} repositories on GitHub:\n\n${formatted.join("\n")}`;
    }

    if (action === "get_repo" || action === "repo_info") {
      const target = repo.includes("/") ? repo : owner && repo ? `${owner}/${repo}` : repo;
      if (!target) return "Error: `repo` name (e.g. 'owner/repo') is required to get repo details.";
      const res = await fetch(`https://api.github.com/repos/${target}`, { headers });
      if (!res.ok) return `GitHub API error (${res.status}): ${await res.text()}`;
      const r = (await res.json()) as Record<string, unknown>;
      return (
        `Repository: **${r["full_name"]}**\n` +
        `- Visibility: ${r["private"] ? "Private" : "Public"}\n` +
        `- Default branch: ${r["default_branch"]}\n` +
        `- Description: ${r["description"] ?? "None"}\n` +
        `- Stars: ${r["stargazers_count"]}, Forks: ${r["forks_count"]}, Open Issues: ${r["open_issues_count"]}\n` +
        `- URL: ${r["html_url"]}`
      );
    }

    if (action === "list_commits") {
      const target = repo.includes("/") ? repo : owner && repo ? `${owner}/${repo}` : repo;
      if (!target) return "Error: `repo` name (e.g. 'owner/repo') is required to list commits.";
      const res = await fetch(`https://api.github.com/repos/${target}/commits?per_page=10`, { headers });
      if (!res.ok) return `GitHub API error (${res.status}): ${await res.text()}`;
      const commits = (await res.json()) as Array<{ sha: string; commit: { message: string; author?: { name: string; date: string } } }>;
      const list = commits.map((c) => `- \`${c.sha.slice(0, 7)}\`: ${c.commit.message.split("\n")[0]} (${c.commit.author?.name ?? "unknown"}, ${c.commit.author?.date ? c.commit.author.date.slice(0, 10) : ""})`);
      return `Recent commits for ${target}:\n${list.join("\n")}`;
    }

    if (action === "list_branches") {
      const target = repo.includes("/") ? repo : owner && repo ? `${owner}/${repo}` : repo;
      if (!target) return "Error: `repo` name (e.g. 'owner/repo') is required to list branches.";
      const res = await fetch(`https://api.github.com/repos/${target}/branches?per_page=20`, { headers });
      if (!res.ok) return `GitHub API error (${res.status}): ${await res.text()}`;
      const branches = (await res.json()) as Array<{ name: string }>;
      return `Branches for ${target}:\n${branches.map((b) => `- ${b.name}`).join("\n")}`;
    }

    return `Unknown action "${action}". Supported actions: list_repos, get_repo, list_commits, list_branches.`;
  } catch (err) {
    return `Failed to query GitHub: ${err instanceof Error ? err.message : String(err)}`;
  }
};
