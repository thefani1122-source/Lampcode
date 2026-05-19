import { readdir, readFile, stat } from "fs/promises";
import { join, extname, relative, basename } from "path";
import { logger } from "../server/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexedFile {
  path: string;
  content: string;
  contentPreview: string;
  exports: string[];
  imports: string[];
  tokens: number;
  lastModified: number;
}

export interface SelectedContext {
  relevantFiles: Array<{ path: string; content: string }>;
  tokenEstimate: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const CONTENT_PREVIEW_CHARS = 500;
const CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4_000;
const TOP_N = 5;

const PINNED_FILES = ["CONTRACT.md", "CURRENT_STATE.md"];

const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".css", ".scss", ".html",
  ".json", ".md", ".yaml", ".yml",
  ".sql", ".env.example",
]);

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  "__pycache__", ".turbo", "coverage", ".cache",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "in", "of", "to", "and", "or", "for",
  "with", "on", "at", "by", "it", "this", "that", "be", "are",
  "was", "were", "do", "does", "did", "have", "has", "had",
  "will", "would", "could", "should", "may", "might", "can",
  "my", "we", "you", "your", "i", "me", "not", "but", "so",
]);

// ── Keyword extraction ────────────────────────────────────────────────────────

function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// ── Simple regex-based import/export extraction ───────────────────────────────

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
const EXPORT_RE = /export\s+(?:(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+)([A-Za-z_$][\w$]*)/g;

function parseImports(content: string): string[] {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    imports.push(m[1] as string);
  }
  return imports;
}

function parseExports(content: string): string[] {
  const exports: string[] = [];
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) {
    exports.push(m[1] as string);
  }
  return exports;
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

/**
 * Score a file for relevance to a set of keywords.
 *
 * Scoring:
 *   +10 per keyword found in the file path (case-insensitive)
 *   +5  per unique keyword found in the file content
 *   +3  per keyword found in import paths or export names
 */
export function scoreFile(file: IndexedFile, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const pathLower = file.path.toLowerCase();
  const contentLower = file.content.toLowerCase();
  const symbolsLower = [...file.imports, ...file.exports].join(" ").toLowerCase();

  let score = 0;
  for (const kw of keywords) {
    if (pathLower.includes(kw))    score += 10;
    if (contentLower.includes(kw)) score +=  5;
    if (symbolsLower.includes(kw)) score +=  3;
  }
  return score;
}

// ── ContextManager ────────────────────────────────────────────────────────────

interface CacheEntry {
  files: IndexedFile[];
  indexedAt: number;
}

export class ContextManager {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Scan the project workspace and return an in-memory file index.
   * Results are cached for CACHE_TTL_MS milliseconds.
   */
  async index(projectId: string, workspaceBase: string): Promise<IndexedFile[]> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined && Date.now() - cached.indexedAt < CACHE_TTL_MS) {
      return cached.files;
    }

    const projectDir = join(workspaceBase, projectId);
    let files: IndexedFile[];
    try {
      files = await this.scanDirectory(projectDir, projectDir);
    } catch {
      files = [];
    }

    this.cache.set(projectId, { files, indexedAt: Date.now() });
    logger.debug({ projectId, fileCount: files.length }, "ContextManager: index built");
    return files;
  }

  /**
   * Select files relevant to `prompt` within the `maxTokens` budget.
   * Always includes CONTRACT.md and CURRENT_STATE.md if they exist.
   */
  async select(opts: {
    projectId: string;
    prompt: string;
    workspaceBase: string;
    maxTokens?: number;
  }): Promise<SelectedContext> {
    const { projectId, prompt, workspaceBase, maxTokens = DEFAULT_MAX_TOKENS } = opts;

    const files = await this.index(projectId, workspaceBase);
    const keywords = extractKeywords(prompt);

    // Score every file
    const scored = files
      .map((file) => ({ file, score: scoreFile(file, keywords) }))
      .sort((a, b) => b.score - a.score);

    const result: IndexedFile[] = [];
    let tokensUsed = 0;

    // Pin CONTRACT.md / CURRENT_STATE.md first
    for (const name of PINNED_FILES) {
      const found = files.find((f) => basename(f.path) === name);
      if (found !== undefined) {
        result.push(found);
        tokensUsed += found.tokens;
      }
    }

    // Add top-scoring files until token budget is exhausted
    let added = 0;
    for (const { file, score } of scored) {
      if (score === 0 || added >= TOP_N) break;
      if (result.some((r) => r.path === file.path)) continue;
      if (tokensUsed + file.tokens > maxTokens) continue;
      result.push(file);
      tokensUsed += file.tokens;
      added++;
    }

    logger.debug(
      { projectId, selected: result.length, tokensUsed, keywords },
      "ContextManager: files selected",
    );

    return {
      relevantFiles: result.map((f) => ({ path: f.path, content: f.content })),
      tokenEstimate: tokensUsed,
    };
  }

  /** Invalidate the cache for a project (call after build writes new files). */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async scanDirectory(base: string, dir: string): Promise<IndexedFile[]> {
    const files: IndexedFile[] = [];
    let entries: string[];

    try {
      entries = await readdir(dir);
    } catch {
      return files;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let s;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        files.push(...await this.scanDirectory(base, fullPath));
      } else if (INDEXABLE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        const indexed = await this.indexFile(base, fullPath, s.mtimeMs);
        if (indexed !== null) files.push(indexed);
      }
    }

    return files;
  }

  private async indexFile(
    base: string,
    fullPath: string,
    lastModified: number,
  ): Promise<IndexedFile | null> {
    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      return null;
    }

    const path = relative(base, fullPath);
    const contentPreview = content.slice(0, CONTENT_PREVIEW_CHARS);
    const tokens = Math.ceil(content.length / CHARS_PER_TOKEN);
    const imports = parseImports(content);
    const exports = parseExports(content);

    return { path, content, contentPreview, exports, imports, tokens, lastModified };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ContextManager | null = null;

export function getContextManager(): ContextManager {
  _instance ??= new ContextManager();
  return _instance;
}
