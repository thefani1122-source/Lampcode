import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { truncate } from "./rest-queries.js";

/**
 * Read-only GitHub lookups over the stored PAT — the built-in counterpart of
 * the hosted GitHub MCP server. Writes (issues, branches, PRs, merges) live in
 * github-writes.ts and are reachable ONLY through the shared approval gate;
 * nothing in this file changes external state.
 */

const API = "https://api.github.com";

export const GITHUB_QUERY_ACTIONS = [
  "list_repos",
  "get_repo",
  "list_commits",
  "list_branches",
  "list_issues",
  "get_issue",
  "search_issues",
  "list_pull_requests",
  "get_pull_request",
  "get_pull_request_files",
  "get_pull_request_status",
  "search_code",
  "get_file_contents",
  "list_workflow_runs",
  "get_workflow_run_jobs",
  "get_job_logs",
] as const;

function resolveRepo(repo: string, owner: string): string {
  return repo.includes("/") ? repo : owner && repo ? `${owner}/${repo}` : repo;
}

async function ghJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* keep raw text */ }
  return { status: res.status, body, text };
}

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
  const state = typeof args["state"] === "string" ? args["state"].trim().toLowerCase() : "";
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  const path = typeof args["path"] === "string" ? args["path"].trim().replace(/^\/+/, "") : "";
  const ref = typeof args["ref"] === "string" ? args["ref"].trim() : "";
  const number = Number(args["issue_number"] ?? args["pull_number"] ?? args["run_id"] ?? args["job_id"] ?? 0);
  const limit = Math.min(Math.max(Number(args["limit"] ?? 10) || 10, 1), 30);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Lampcode-Agent/1.0",
  };

  const target = resolveRepo(repo, owner);
  const needsRepo = action !== "list_repos" && action !== "search_code" && action !== "search_issues";
  if (needsRepo && !target) {
    return "Error: a `repo` name (e.g. 'owner/repo') is required for this action.";
  }
  const enc = encodeURIComponent;

  try {
    // ── Repos ───────────────────────────────────────────────────────────────
    if (action === "list_repos" || !action) {
      const { status, body } = await ghJson(`${API}/user/repos?per_page=30&sort=updated`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const data = body as Array<Record<string, unknown>>;
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
      const { status, body } = await ghJson(`${API}/repos/${target}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const r = body as Record<string, unknown>;
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
      const branch = ref ? `?sha=${enc(ref)}&` : "?";
      const { status, body } = await ghJson(`${API}/repos/${target}/commits${branch}per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const commits = body as Array<{ sha: string; commit: { message: string; author?: { name: string; date: string } } }>;
      const list = commits.map((c) => `- \`${c.sha.slice(0, 7)}\`: ${c.commit.message.split("\n")[0]} (${c.commit.author?.name ?? "unknown"}, ${c.commit.author?.date ? c.commit.author.date.slice(0, 10) : ""})`);
      return `Recent commits for ${target}:\n${list.join("\n")}`;
    }

    if (action === "list_branches") {
      const { status, body } = await ghJson(`${API}/repos/${target}/branches?per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const branches = body as Array<{ name: string; commit: { sha: string } }>;
      return `Branches for ${target}:\n${branches.map((b) => `- ${b.name} (${b.commit.sha.slice(0, 7)})`).join("\n")}`;
    }

    // ── Files & code search ─────────────────────────────────────────────────
    if (action === "get_file_contents") {
      if (!path) return "Error: a `path` (e.g. 'src/index.ts') is required to read a file.";
      const r = ref ? `?ref=${enc(ref)}` : "";
      // Each path segment is encoded separately so slashes keep their
      // meaning in the URL; the whole path must not be encoded as one piece.
      const encodedPath = path.split("/").map((seg) => enc(seg)).join("/");
      const { status, body, text } = await ghJson(`${API}/repos/${target}/contents/${encodedPath}${r}`, headers);
      if (status === 404) return `File not found: \`${path}\` on ${ref || "the default branch"} of ${target}.`;
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      if (Array.isArray(body)) {
        const items = body as Array<Record<string, unknown>>;
        return `\`${path}\` is a directory with ${items.length} entries:\n${items.map((i) => `- ${i["type"] === "dir" ? "dir" : "file"} ${i["name"]}`).join("\n")}`;
      }
      const file = body as Record<string, unknown>;
      const content = typeof file["content"] === "string" ? Buffer.from(String(file["content"]), "base64").toString("utf-8") : String(text);
      return `Contents of \`${path}\` (${file["size"] ?? "?"} bytes):\n\n${truncate(content, 4000)}`;
    }

    if (action === "search_code") {
      if (!query) return "Error: a `query` is required to search code.";
      const q = target ? `${query} repo:${target}` : query;
      const { status, body } = await ghJson(`${API}/search/code?q=${enc(q)}&per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const results = ((body as Record<string, unknown>)["items"] ?? []) as Array<Record<string, unknown>>;
      if (results.length === 0) return `No code results for "${query}".`;
      return (
        `Code search results for "${query}" (${(body as Record<string, unknown>)["total_count"]} total):\n\n` +
        results.map((r) => `- **${r["path"]}** in ${r["repository"] ? (r["repository"] as Record<string, unknown>)["full_name"] : "?"}`).join("\n")
      );
    }

    // ── Issues ──────────────────────────────────────────────────────────────
    if (action === "list_issues" || action === "search_issues") {
      if (action === "search_issues") {
        if (!query) return "Error: a `query` is required to search issues.";
        const scope = target ? `repo:${target} ` : "";
        const { status, body } = await ghJson(`${API}/search/issues?q=${enc(`${scope}${query} type:issue`)}&per_page=${limit}`, headers);
        if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
        const items = ((body as Record<string, unknown>)["items"] ?? []) as Array<Record<string, unknown>>;
        if (items.length === 0) return `No issues matched "${query}".`;
        return (
          `Issues matching "${query}":\n\n` +
          items.map((i) => `- #${i["number"]} **${i["title"]}** [${i["state"]}] (${i["html_url"]})`).join("\n")
        );
      }
      const s = state && ["open", "closed", "all"].includes(state) ? state : "open";
      const { status, body } = await ghJson(`${API}/repos/${target}/issues?state=${s}&per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const issues = (body as Array<Record<string, unknown>>).filter((i) => !i["pull_request"]);
      if (issues.length === 0) return `No ${s} issues on ${target}.`;
      return (
        `${s === "all" ? "" : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)} `}Issues on ${target}:\n\n` +
        issues.map((i) => {
          const labels = Array.isArray(i["labels"]) ? (i["labels"] as Array<Record<string, unknown>>).map((l) => String(l["name"])).join(", ") : "";
          return `- #${i["number"]} **${i["title"]}** [${i["state"]}]${labels ? ` (labels: ${labels})` : ""}`;
        }).join("\n")
      );
    }

    if (action === "get_issue") {
      if (!number) return "Error: an `issue_number` is required.";
      const { status, body } = await ghJson(`${API}/repos/${target}/issues/${number}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const issue = body as Record<string, unknown>;
      const comments = await ghJson(`${API}/repos/${target}/issues/${number}/comments?per_page=5`, headers);
      const commentLines = comments.status === 200
        ? (comments.body as Array<Record<string, unknown>>).map((c) => `  - ${c["user"] ? (c["user"] as Record<string, unknown>)["login"] : "?"}: ${truncate(String(c["body"] ?? ""), 300)}`)
        : [];
      return (
        `Issue #${issue["number"]}: **${issue["title"]}** [${issue["state"]}]\n` +
        `- Author: ${issue["user"] ? (issue["user"] as Record<string, unknown>)["login"] : "?"}\n` +
        `- Created: ${String(issue["created_at"] ?? "").slice(0, 10)}${issue["closed_at"] ? `, closed: ${String(issue["closed_at"]).slice(0, 10)}` : ""}\n` +
        `- Body: ${truncate(String(issue["body"] ?? "(empty)"), 800)}\n` +
        (commentLines.length > 0 ? `- Recent comments:\n${commentLines.join("\n")}` : "- No comments.")
      );
    }

    // ── Pull requests ───────────────────────────────────────────────────────
    if (action === "list_pull_requests") {
      const s = state && ["open", "closed", "all"].includes(state) ? state : "open";
      const { status, body } = await ghJson(`${API}/repos/${target}/pulls?state=${s}&per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const pulls = body as Array<Record<string, unknown>>;
      if (pulls.length === 0) return `No ${s} pull requests on ${target}.`;
      return (
        `${s === "all" ? "" : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)} `}Pull requests on ${target}:\n\n` +
        pulls.map((p) => `- #${p["number"]} **${p["title"]}** [${p["state"]}] \`${p["head"] ? (p["head"] as Record<string, unknown>)["ref"] : "?"}\` → \`${p["base"] ? (p["base"] as Record<string, unknown>)["ref"] : "?"}\` (draft: ${p["draft"] ? "yes" : "no"})`).join("\n")
      );
    }

    if (action === "get_pull_request") {
      if (!number) return "Error: a `pull_number` is required.";
      const { status, body } = await ghJson(`${API}/repos/${target}/pulls/${number}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const p = body as Record<string, unknown>;
      const head = p["head"] as Record<string, unknown> | undefined;
      const base = p["base"] as Record<string, unknown> | undefined;
      return (
        `Pull request #${p["number"]}: **${p["title"]}** [${p["state"]}${p["draft"] ? ", draft" : ""}${p["merged"] ? ", MERGED" : ""}]\n` +
        `- Branches: \`${head?.["ref"]}\` → \`${base?.["ref"]}\`\n` +
        `- Mergeable: ${String(p["mergeable"] ?? "unknown")} (state: ${String(p["mergeable_state"] ?? "unknown")})\n` +
        `- Changes: +${p["additions"] ?? "?"} / -${p["deletions"] ?? "?"} across ${p["changed_files"] ?? "?"} files\n` +
        `- Body: ${truncate(String(p["body"] ?? "(empty)"), 600)}\n` +
        `- URL: ${p["html_url"]}`
      );
    }

    if (action === "get_pull_request_files") {
      if (!number) return "Error: a `pull_number` is required.";
      const { status, body } = await ghJson(`${API}/repos/${target}/pulls/${number}/files?per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const files = body as Array<Record<string, unknown>>;
      if (files.length === 0) return `No file changes recorded on PR #${number}.`;
      return (
        `Files changed in PR #${number}:\n\n` +
        files.map((f) => `- **${f["filename"]}** (+${f["additions"]} / -${f["deletions"]}, ${f["status"]})\n\`\`\`\n${truncate(String(f["patch"] ?? "(no patch shown)"), 1200)}\n\`\`\``).join("\n\n")
      );
    }

    if (action === "get_pull_request_status") {
      if (!number) return "Error: a `pull_number` is required.";
      const pr = await ghJson(`${API}/repos/${target}/pulls/${number}`, headers);
      if (pr.status !== 200) return `GitHub API error (${pr.status}): ${truncate(pr.body)}`;
      const headObj = (pr.body as Record<string, unknown>)["head"] as Record<string, unknown> | undefined;
      const sha = String(headObj?.["sha"] ?? "");
      if (!sha) return `Could not resolve the head commit of PR #${number}.`;
      const [checks, combined] = await Promise.all([
        ghJson(`${API}/repos/${target}/commits/${sha}/check-runs?per_page=${limit}`, headers),
        ghJson(`${API}/repos/${target}/commits/${sha}/status`, headers),
      ]);
      const runs = checks.status === 200 ? ((checks.body as Record<string, unknown>)["check_runs"] ?? []) as Array<Record<string, unknown>> : [];
      const ciLines = runs.map((c) => `- ${c["name"]}: **${c["conclusion"] ?? c["status"]}**${c["html_url"] ? ` (${c["html_url"]})` : ""}`);
      const ciState = combined.status === 200 ? String((combined.body as Record<string, unknown>)["state"]) : "unknown";
      return `CI status for PR #${number} (head ${sha.slice(0, 7)}):\n- Combined commit status: **${ciState}**\n${ciLines.length > 0 ? ciLines.join("\n") : "- No check runs recorded."}`;
    }

    // ── Actions / CI ────────────────────────────────────────────────────────
    if (action === "list_workflow_runs") {
      const branch = ref ? `&branch=${enc(ref)}` : "";
      const { status, body } = await ghJson(`${API}/repos/${target}/actions/runs?per_page=${limit}${branch}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const runs = ((body as Record<string, unknown>)["workflow_runs"] ?? []) as Array<Record<string, unknown>>;
      if (runs.length === 0) return `No workflow runs found on ${target}.`;
      return (
        `Recent workflow runs on ${target}:\n\n` +
        runs.map((r) => `- #${r["run_number"]} **${r["name"] ?? r["display_title"]}** — ${r["status"]}${r["conclusion"] ? ` (${r["conclusion"]})` : ""} on \`${r["head_branch"]}\` [run_id: ${r["id"]}]`).join("\n")
      );
    }

    if (action === "get_workflow_run_jobs") {
      if (!number) return "Error: a `run_id` is required (use list_workflow_runs to find one).";
      const { status, body } = await ghJson(`${API}/repos/${target}/actions/runs/${number}/jobs?per_page=${limit}`, headers);
      if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
      const jobs = ((body as Record<string, unknown>)["jobs"] ?? []) as Array<Record<string, unknown>>;
      if (jobs.length === 0) return `No jobs recorded for run ${number}.`;
      return (
        `Jobs for workflow run ${number}:\n\n` +
        jobs.map((j) => `- **${j["name"]}** — ${j["status"]}${j["conclusion"] ? ` (${j["conclusion"]})` : ""} [job_id: ${j["id"]}]`).join("\n")
      );
    }

    if (action === "get_job_logs") {
      if (!number) return "Error: a `job_id` is required (use get_workflow_run_jobs to find one).";
      const res = await fetch(`${API}/repos/${target}/actions/jobs/${number}/logs`, {
        headers,
        redirect: "follow",
      });
      if (res.status === 404) return `No logs found for job ${number}.`;
      if (res.status !== 200) return `GitHub API error (${res.status}): ${truncate(await res.text())}`;
      const logs = await res.text();
      // Failed steps matter most: keep the tail, where failures usually are.
      return `Logs for job ${number} (last ${Math.min(logs.length, 4000)} of ${logs.length} chars):\n\n${truncate(logs, 4000)}`;
    }

    return `Unknown action "${action}". Supported actions: ${GITHUB_QUERY_ACTIONS.join(", ")}.`;
  } catch (err) {
    return `Failed to query GitHub: ${err instanceof Error ? err.message : String(err)}`;
  }
};
