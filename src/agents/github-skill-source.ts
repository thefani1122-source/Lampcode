export interface GitHubSkillSource {
  owner: string;
  repo: string;
  ref?: string;
  skillPath?: string;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSafeRef(value: string): boolean {
  return value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.split("/").some((part) => part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part));
}

function isSafeRepoPath(value: string): boolean {
  if (!value) return true;
  if (value.length > 240 || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) =>
    part.length > 0 &&
    part !== "." &&
    part !== ".." &&
    /^[A-Za-z0-9._-]{1,100}$/.test(part),
  );
}

/**
 * Accept only canonical HTTPS GitHub repository / tree / SKILL.md URLs.
 * This is deliberately not a general URL fetcher: arbitrary hosts, ports,
 * userinfo and non-HTTPS protocols are rejected before any network request.
 */
export function parseGitHubSkillSourceUrl(raw: string): GitHubSkillSource | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) return null;

  const trimmed = raw.trim();
  // WHATWG URL canonicalization removes literal and percent-encoded dot
  // segments. Inspect the original path first so traversal attempts are
  // rejected rather than silently normalized into a different GitHub path.
  const rawPathMatch = /^https:\/\/[^/?#]+([^?#]*)/i.exec(trimmed);
  const rawPath = rawPathMatch?.[1] ?? "";
  if (rawPath.includes("\\")) return null;
  for (const segment of rawPath.split("/")) {
    let decodedSegmentValue: string;
    try {
      decodedSegmentValue = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decodedSegmentValue.includes("\\") ||
      decodedSegmentValue.split("/").some((part) => part === "." || part === "..")
    ) {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["github.com", "raw.githubusercontent.com"].includes(url.hostname)
  ) {
    return null;
  }

  const encodedParts = url.pathname.split("/").filter(Boolean);
  const parts = encodedParts.map(decodeSegment);
  if (parts.some((part) => part === null)) return null;
  const decoded = parts as string[];

  let owner = "";
  let repo = "";
  let ref = "";
  let skillPath = "";
  let pathIsExplicit = false;

  if (url.hostname === "github.com") {
    if (decoded.length < 2) return null;
    owner = decoded[0] ?? "";
    repo = decoded[1] ?? "";
    if (decoded.length === 2) {
      ref = url.searchParams.get("ref") ?? "";
    } else {
      const mode = decoded[2];
      if (mode !== "tree" && mode !== "blob") return null;
      if (decoded.length < 4) return null;
      ref = decoded[3] ?? "";
      const remaining = decoded.slice(4);
      if (mode === "blob") {
        if (remaining.at(-1) !== "SKILL.md") return null;
        remaining.pop();
      } else if (remaining.at(-1) === "SKILL.md") {
        remaining.pop();
      }
      skillPath = remaining.join("/");
      pathIsExplicit = true;
    }
  } else {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md
    if (decoded.length < 4) return null;
    owner = decoded[0] ?? "";
    repo = decoded[1] ?? "";
    ref = decoded[2] ?? "";
    const remaining = decoded.slice(3);
    if (remaining.at(-1) !== "SKILL.md") return null;
    remaining.pop();
    skillPath = remaining.join("/");
    pathIsExplicit = true;
  }

  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!/^[A-Za-z0-9_.-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  if (ref && !isSafeRef(ref)) return null;
  if (pathIsExplicit && !isSafeRepoPath(skillPath)) return null;

  return {
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(pathIsExplicit ? { skillPath } : {}),
  };
}

/** Convert a repository-relative folder or SKILL.md path to its skill folder. */
export function normalizeGitHubSkillPath(value: string): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (path.startsWith("/")) return null;
  path = path.replace(/\/+$/, "");
  if (path === "SKILL.md") return "";
  if (path.endsWith("/SKILL.md")) path = path.slice(0, -"/SKILL.md".length);
  return isSafeRepoPath(path) ? path : null;
}

/**
 * Find standard Agent Skills entry points in a Git tree. An explicit scope
 * returns only that directory's SKILL.md; no scope returns all candidates,
 * with a root skill first.
 */
export function findGitHubSkillPaths(paths: string[], scopePath?: string): string[] {
  const safePaths = paths.filter((path) =>
    typeof path === "string" &&
    (path === "SKILL.md" || path.endsWith("/SKILL.md"))
  ).filter((path) => isSafeRepoPath(path));

  if (scopePath !== undefined) {
    const normalized = normalizeGitHubSkillPath(scopePath);
    if (normalized === null) return [];
    const expected = normalized ? normalized + "/SKILL.md" : "SKILL.md";
    return safePaths.includes(expected) ? [expected] : [];
  }

  return [...new Set(safePaths)].sort((a, b) => {
    if (a === "SKILL.md") return -1;
    if (b === "SKILL.md") return 1;
    return a.localeCompare(b);
  });
}
