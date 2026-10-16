/**
 * Search the file map already held by a build. Keeping this module pure means
 * the search works before a sandbox exists and cannot drift from disk state.
 */
export type SearchHit = {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
};

export type SearchOptions = {
  query: string;
  isRegex?: boolean;
  pathGlob?: string;
  maxResults?: number;
};

export type SearchResult = {
  hits: SearchHit[];
  truncated: boolean;
  filesSearched: number;
  filesSkipped: number;
  error?: string;
};

const DEFAULT_MAX_RESULTS = 40;
const MAX_MAX_RESULTS = 100;
const MAX_FILE_CHARS = 200 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 1_000;
const SKIP_DIRS = new Set([".git", "dist", "node_modules"]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isArtifactPath(path: string): boolean {
  return normalizePath(path).split("/").some((part) => SKIP_DIRS.has(part));
}

function isBinaryLike(content: string): boolean {
  if (content.includes("\0")) return true;
  const sample = content.slice(0, 8_192);
  const controls = sample.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)?.length ?? 0;
  return sample.length > 0 && controls / sample.length > 0.01;
}

/** A single star stays in one path segment; a double star can cross folders. */
function globMatcher(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

function boundedMax(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_MAX_RESULTS, Math.floor(value!)));
}

function clipLine(line: string): { text: string; clipped: boolean } {
  return line.length > MAX_LINE_CHARS
    ? { text: line.slice(0, MAX_LINE_CHARS) + "…", clipped: true }
    : { text: line, clipped: false };
}

function formatHit(hit: SearchHit): string {
  const firstLine = hit.line - hit.before.length;
  const before = hit.before.map((text, i) => "  " + (firstLine + i) + ": " + text);
  const after = hit.after.map((text, i) => "  " + (hit.line + i + 1) + ": " + text);
  return [
    hit.path + ":" + hit.line,
    ...before,
    "> " + hit.line + ": " + hit.text,
    ...after,
  ].join("\n");
}

function header(result: SearchResult): string {
  const parts = [result.filesSearched + " file(s) searched"];
  if (result.filesSkipped > 0) parts.push(result.filesSkipped + " vendor, generated, oversized, or binary file(s) skipped");
  return parts.join("; ") + ".";
}

export function searchFiles(
  files: Record<string, string>,
  opts: SearchOptions,
): { hits: SearchHit[]; truncated: boolean; filesSearched: number; filesSkipped: number; error?: string } {
  if (typeof opts.query !== "string" || opts.query.length === 0) {
    return { hits: [], truncated: false, filesSearched: 0, filesSkipped: 0, error: "Search query is empty." };
  }

  let matcher: RegExp | undefined;
  if (opts.isRegex) {
    try {
      matcher = new RegExp(opts.query);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        hits: [],
        truncated: false,
        filesSearched: 0,
        filesSkipped: 0,
        error: "Invalid regular expression: " + reason,
      };
    }
  }
  const pathMatcher = opts.pathGlob ? globMatcher(normalizePath(opts.pathGlob)) : undefined;
  const maxResults = boundedMax(opts.maxResults);
  const hits: SearchHit[] = [];
  let filesSearched = 0;
  let filesSkipped = 0;
  let truncated = false;

  for (const [rawPath, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof content !== "string") {
      filesSkipped++;
      continue; // malformed memory entries must not break search
    }
    const path = normalizePath(rawPath);
    if (
      isArtifactPath(path) ||
      content.length > MAX_FILE_CHARS ||
      isBinaryLike(content)
    ) {
      filesSkipped++;
      continue;
    }
    if (pathMatcher && !pathMatcher.test(path)) continue;

    filesSearched++;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const matched = matcher ? matcher.test(line) : line.includes(opts.query);
      if (!matched) continue;
      if (hits.length >= maxResults) {
        truncated = true;
        continue; // still count scanned files and skipped artifacts truthfully
      }

      const beforeStart = Math.max(0, index - CONTEXT_LINES);
      const afterEnd = Math.min(lines.length - 1, index + CONTEXT_LINES);
      const before = lines.slice(beforeStart, index).map((text) => {
        const clipped = clipLine(text);
        if (clipped.clipped) truncated = true;
        return clipped.text;
      });
      const clippedMatch = clipLine(line);
      if (clippedMatch.clipped) truncated = true;
      const after = lines.slice(index + 1, afterEnd + 1).map((text) => {
        const clipped = clipLine(text);
        if (clipped.clipped) truncated = true;
        return clipped.text;
      });
      hits.push({ path, line: index + 1, text: clippedMatch.text, before, after });
    }
  }

  // Bound the actual text re-paid in later model rounds, without cutting a hit
  // or its context in half.
  while (
    hits.length > 0 &&
    formatSearchHits({ hits, truncated: true, filesSearched, filesSkipped }).length > MAX_OUTPUT_CHARS
  ) {
    hits.pop();
    truncated = true;
  }

  return { hits, truncated, filesSearched, filesSkipped };
}

export function formatSearchHits(result: ReturnType<typeof searchFiles>): string {
  if (result.error) return result.error;
  const intro = header(result);
  if (result.hits.length === 0) {
    return intro + "\nNo matches found.";
  }
  return [
    intro,
    "",
    result.hits.map(formatHit).join("\n\n"),
    ...(result.truncated ? ["", "Results truncated. Narrow the search or request a specific folder."] : []),
  ].join("\n");
}