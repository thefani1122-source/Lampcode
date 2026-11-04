import type { ToolDefinition } from "./../model-gateway.js";
import type { ToolExecutionContext } from "../tools.js";
import type { WriteMcpMeta } from "../mcp-tool-classifier.js";
import type { Tier } from "../../mcp/tiers.js";
import { truncate } from "./rest-queries.js";

/**
 * Write tools for GitHub over the stored PAT — the counterpart of the
 * read-only lookups in github-query.ts. These are never registered in the
 * static handler registry: the ONLY path to them runs through the shared write
 * approval gate (build:write_action_approval_required) in executeTool, so a
 * user always sees and approves what will happen before it happens.
 *
 * This mirrors what the hosted GitHub MCP write proxies offer when that
 * integration is connected; with only a PAT stored, these keep issues, PRs,
 * branches and merges working. Reversible creates are "approval"; merging a
 * pull request changes the default history and is "strong-approval".
 * Deletion (issues, branches, repos) is deliberately NOT offered here.
 */

const API = "https://api.github.com";

async function ghSend(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  headers: Record<string, string>,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
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

function num(args: Record<string, unknown>, key: string): number {
  return Number(args[key] ?? 0);
}

function repoOf(args: Record<string, unknown>): string {
  const repo = str(args, "repo");
  return repo.includes("/") ? repo : "";
}

function headersFor(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Lampcode-Agent/1.0",
  };
}

export const githubWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const token = ctx.gitHubToken;
  if (!token) return "GitHub is not connected. Please tell the user to connect GitHub in the Integrations store first.";
  const headers = headersFor(token);

  const action = str(args, "action") || "create_issue";
  const target = repoOf(args);
  if (!target) return "Error: a `repo` name in 'owner/repo' form is required.";
  const enc = encodeURIComponent;

  if (action === "create_issue") {
    const title = str(args, "title");
    if (!title) return "Error: a `title` is required to create an issue.";
    const labels = Array.isArray(args["labels"]) ? (args["labels"] as unknown[]).filter((l): l is string => typeof l === "string") : [];
    const { status, body } = await ghSend(`${API}/repos/${enc(target)}/issues`, "POST", headers, {
      title,
      ...(str(args, "body") ? { body: str(args, "body") } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    });
    if (status !== 201) return `GitHub API error (${status}): ${truncate(body)}`;
    const issue = body as Record<string, unknown>;
    return `Created issue #${issue["number"]} **${title}** on ${target}: ${issue["html_url"]}`;
  }

  if (action === "comment_on_issue") {
    const number = num(args, "issue_number");
    const comment = str(args, "comment");
    if (!number) return "Error: an `issue_number` is required to comment.";
    if (!comment) return "Error: a `comment` is required to comment.";
    const { status, body } = await ghSend(`${API}/repos/${enc(target)}/issues/${number}/comments`, "POST", headers, { body: comment });
    if (status !== 201) return `GitHub API error (${status}): ${truncate(body)}`;
    const created = body as Record<string, unknown>;
    return `Commented on issue #${number} on ${target}: ${created["html_url"]}`;
  }

  if (action === "close_issue") {
    const number = num(args, "issue_number");
    if (!number) return "Error: an `issue_number` is required to close an issue.";
    if (str(args, "comment")) {
      const comment = await ghSend(`${API}/repos/${enc(target)}/issues/${number}/comments`, "POST", headers, { body: str(args, "comment") });
      if (comment.status !== 201) return `GitHub API error (${comment.status}): ${truncate(comment.body)}`;
    }
    const { status, body } = await ghSend(`${API}/repos/${enc(target)}/issues/${number}`, "PATCH", headers, { state: "closed" });
    if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
    const issue = body as Record<string, unknown>;
    return `Closed issue #${issue["number"]} on ${target} (state: ${issue["state"]}).`;
  }

  if (action === "create_branch") {
    const branch = str(args, "branch");
    if (!branch) return "Error: a `branch` name is required to create a branch.";
    const from = str(args, "from_branch");

    // Resolve the source ref: a named branch when given, otherwise the
    // repository's default branch (two reads — nothing here writes yet).
    let sha = "";
    if (from) {
      const refRes = await fetch(`${API}/repos/${enc(target)}/git/ref/heads/${enc(from)}`, {
        headers: { ...headersFor(token), Accept: "application/vnd.github+json" },
      });
      if (!refRes.ok) return `Could not resolve source branch \`${from}\` on ${target}: GitHub API error (${refRes.status}).`;
      const refBody = (await refRes.json()) as Record<string, unknown>;
      sha = String((refBody["object"] as Record<string, unknown> | undefined)?.["sha"] ?? "");
    } else {
      const repoRes = await fetch(`${API}/repos/${enc(target)}`, {
        headers: { ...headersFor(token), Accept: "application/vnd.github+json" },
      });
      if (!repoRes.ok) return `Could not read ${target}: GitHub API error (${repoRes.status}).`;
      const repo = (await repoRes.json()) as Record<string, unknown>;
      const defaultBranch = String(repo["default_branch"] ?? "");
      const refRes = await fetch(`${API}/repos/${enc(target)}/git/ref/heads/${enc(defaultBranch)}`, {
        headers: { ...headersFor(token), Accept: "application/vnd.github+json" },
      });
      if (!refRes.ok) return `Could not resolve the default branch on ${target}: GitHub API error (${refRes.status}).`;
      const refBody = (await refRes.json()) as Record<string, unknown>;
      sha = String((refBody["object"] as Record<string, unknown> | undefined)?.["sha"] ?? "");
    }
    if (!sha) return "Could not resolve a source commit SHA for the new branch.";

    const created = await ghSend(`${API}/repos/${enc(target)}/git/refs`, "POST", headers, { ref: `refs/heads/${branch}`, sha });
    if (created.status !== 201) return `GitHub API error (${created.status}): ${truncate(created.body)}`;
    return `Created branch \`${branch}\` on ${target} from \`${from || "the default branch"}\` (${sha.slice(0, 7)}).`;
  }

  if (action === "create_pull_request") {
    const head = str(args, "head");
    const base = str(args, "base");
    const title = str(args, "title");
    if (!head || !base) return "Error: both `head` (source branch) and `base` (target branch) are required.";
    if (!title) return "Error: a `title` is required to open a pull request.";
    const { status, body } = await ghSend(`${API}/repos/${enc(target)}/pulls`, "POST", headers, {
      title,
      head,
      base,
      ...(str(args, "body") ? { body: str(args, "body") } : {}),
      draft: args["draft"] === true,
    });
    if (status !== 201) return `GitHub API error (${status}): ${truncate(body)}`;
    const pr = body as Record<string, unknown>;
    return `Opened pull request #${pr["number"]} **${title}** (\`${head}\` → \`${base}\`) on ${target}: ${pr["html_url"]}`;
  }

  return `Unknown action. Supported github_write actions: create_issue, comment_on_issue, close_issue, create_branch, create_pull_request.`;
};

export const githubMergeHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const token = ctx.gitHubToken;
  if (!token) return "GitHub is not connected. Please tell the user to connect GitHub in the Integrations store first.";
  const target = repoOf(args);
  if (!target) return "Error: a `repo` name in 'owner/repo' form is required.";
  const number = num(args, "pull_number");
  if (!number) return "Error: a `pull_number` is required to merge a pull request.";
  const method = str(args, "merge_method") || "merge";
  if (!["merge", "squash", "rebase"].includes(method)) {
    return "Error: `merge_method` must be one of merge, squash, rebase.";
  }
  const { status, body } = await ghSend(
    `${API}/repos/${encodeURIComponent(target)}/pulls/${number}/merge`,
    "PUT",
    headersFor(token),
    { merge_method: method },
  );
  if (status !== 200) return `GitHub API error (${status}): ${truncate(body)}`;
  const merged = body as Record<string, unknown>;
  return `Merged pull request #${number} on ${target} (${method}). Merge commit: ${merged["sha"] ? String(merged["sha"]).slice(0, 7) : "n/a"}.`;
};

// ── Definitions + approval-gate registry ────────────────────────────────────

const DEFINE = (name: string, description: string, properties: Record<string, unknown>): ToolDefinition => ({
  name,
  description,
  input_schema: { type: "object", properties, required: [] },
});

export const GITHUB_WRITE_DEFS: ToolDefinition[] = [
  DEFINE(
    "github_write",
    "Create or change things in the user's connected GitHub repository. WRITE actions: the user " +
      "is asked to approve first. Actions: create_issue (opens a new issue), comment_on_issue, " +
      "close_issue (optionally with a closing comment), create_branch (from an existing branch), " +
      "create_pull_request (opens a PR between two branches). Deleting issues or branches is NOT " +
      "offered — tell the user to do deletions themselves.",
    {
      action: { type: "string", enum: ["create_issue", "comment_on_issue", "close_issue", "create_branch", "create_pull_request"], description: "Which write to perform. Default 'create_issue'." },
      repo: { type: "string", description: "Repository in 'owner/repo' form (use github_query to find it)." },
      title: { type: "string", description: "Title ('create_issue', 'create_pull_request')." },
      body: { type: "string", description: "Body text ('create_issue', 'create_pull_request'), optional." },
      labels: { type: "array", items: { type: "string" }, description: "Label names for 'create_issue', optional." },
      issue_number: { type: "string", description: "Issue number ('comment_on_issue', 'close_issue')." },
      comment: { type: "string", description: "Comment text ('comment_on_issue') or closing comment ('close_issue'), optional." },
      branch: { type: "string", description: "New branch name ('create_branch')." },
      from_branch: { type: "string", description: "Source branch for 'create_branch'; defaults to the repository default branch." },
      head: { type: "string", description: "Source branch ('create_pull_request')." },
      base: { type: "string", description: "Target branch ('create_pull_request')." },
      draft: { type: "string", description: "Set to 'true' to open the pull request as a draft." },
    },
  ),
  DEFINE(
    "github_merge",
    "Merge a pull request in the user's connected GitHub repository. This is a POSSIBLY " +
      "IRREVERSIBLE write: it changes the repository's history and the user is asked to explicitly " +
      "approve it. Say what will be merged and into which branch before you call it.",
    {
      repo: { type: "string", description: "Repository in 'owner/repo' form." },
      pull_number: { type: "string", description: "Pull request number (use github_query to find it)." },
      merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Defaults to 'merge'." },
    },
  ),
];

export function buildGithubWriteRegistry(gitHubToken?: string): Map<string, WriteMcpMeta> {
  const registry = new Map<string, WriteMcpMeta>();
  if (!gitHubToken) return registry; // fail closed: no token → no write tools offered
  const tierFor = (name: string): Tier => (name === "github_merge" ? "strong-approval" : "approval");
  const handlers: Record<string, (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>> = {
    github_write: githubWriteHandler,
    github_merge: githubMergeHandler,
  };
  for (const def of GITHUB_WRITE_DEFS) {
    const handler = handlers[def.name];
    if (!handler) continue;
    registry.set(def.name, {
      serverSlug: "github",
      serverUrl: "",
      authToken: null,
      mcpToolName: def.name,
      tier: tierFor(def.name),
      capability: null,
      localExecute: handler,
    });
  }
  return registry;
}
