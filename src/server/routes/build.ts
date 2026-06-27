import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc, isNotNull } from "drizzle-orm";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "fs/promises";
import { join, dirname, relative, resolve, sep } from "path";
import { db } from "../../db/client.js";
import {
  projects,
  buildSessions,
  agentTasks,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getDispatcher } from "../../agents/dispatcher.js";
import { tierModel } from "../../agents/model-gateway.js";
import { detectDatabase, detectFullstackFramework, expandUserPrompt, PYTHON_BACKEND_RE, type FullstackFramework } from "../../agents/prompt-builder.js";
import { validateSyntax } from "../../agents/syntax-check.js";
import {
  parseFilesFromContent,
  findMissingFullstackFiles,
  validateSandpackFiles,
  parseSurgicalEdits,
  applySurgicalEdit,
  stripEditMarkers,
  isBackendFile,
  isSandpackExcluded,
  type ParsedFile,
} from "../../agents/file-parser.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";
import { deductCredits, refundCredits, ensureStartingCredits } from "../../build/credits.js";
import { isAdmin } from "../../auth/admin.js";
import { createPreviewSandbox, killSandbox, hasSandbox, hasSandboxRecord, writeFilesToSandbox, prewarmSandbox, setProjectPreviewEnv, verifyPreview } from "../../preview/e2b-service.js";
import { getUserSupabasePreviewCreds, getUserSupabaseMcpAuth, getConnectedMcpServers, getConnectedRestProviders } from "./integrations.js";
import { applySupabaseSchema } from "../../mcp/supabase-mcp.js";
import { runMcpAction } from "../../agents/mcp-action-agent.js";
import { config } from "../config.js";
import Anthropic from "@anthropic-ai/sdk";
import { generateProjectMemory } from "../../agents/memory-generator.js";
import { generateFileManifest } from "../../agents/manifest-generator.js";
import { uploadProjectFiles, downloadProjectFiles } from "../../storage/project-files.js";
import { classifyBuild } from "../../agents/build-classifier.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLARIFY_SYSTEM = `You are a technical analyst. Analyze user prompts and determine if clarification is needed before building.

Only ask questions when the prompt is for:
- SaaS tools, platforms, marketplaces
- Apps with multiple user types or roles
- Apps that handle payments or subscriptions
- Apps with complex data relationships

DO NOT ask questions for:
- Simple UI components or pages
- Landing pages or portfolios
- Design clones ("make it look like X")
- Single-purpose utilities

Return ONLY valid JSON, no markdown, no explanation:
{
  "needsClarification": boolean,
  "questions": [
    {
      "id": "q1",
      "heading": "Short heading (3-5 words)",
      "reason": "One sentence: why you need this info and how it affects the build",
      "question": "The actual question (concise)",
      "options": ["Option 1", "Option 2", "Option 3"],
      "allowMultiple": false,
      "allowCustom": true
    }
  ]
}

Max 4 questions. Min 0 (needsClarification: false).
Options must be exactly 3 per question.
allowMultiple: true only for user-type questions.`;

// Only match explicit external-service commands — NOT general app-building language.
const ACTION_MODE_RE = /\b(push (?:to|commit to) github|create (?:github repo|repository|issue|pull request|pr)|send (?:email via|slack message|webhook to|notification to)|trigger (?:webhook|zapier|n8n workflow)|deploy to (?:vercel|cloudflare|railway|netlify)|post to (?:slack|twitter|discord|notion)|sync (?:to|with) (?:github|notion|linear|jira)|create (?:n8n workflow|linear issue|jira ticket|notion page)|push (?:code|files) to|commit and push)\b/i;

// Detects a reference URL in the prompt — when present, Firecrawl is used to
// scrape the page before the agent executes the rest of the request.
const URL_REGEX = /https?:\/\/[^\s]+/;

const WORKSPACE_BASE = join(process.cwd(), "workspace");

const FAST_BUILD_CREDIT_COST = process.env["FAST_BUILD_CREDIT_COST"]
  ? parseInt(process.env["FAST_BUILD_CREDIT_COST"], 10)
  : 20;

// ── In-memory cancel registry ─────────────────────────────────────────────────

const cancelledSessions = new Set<string>();

// ── WS helper — never throws ──────────────────────────────────────────────────

function ws() {
  try {
    return getWebSocketServer();
  } catch (err) {
    logger.error({ err }, "WebSocketServer not initialised — build events will not be emitted");
    return null;
  }
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const clarifyBodySchema = z.object({
  prompt: z.string().min(1).max(4_000),
  projectId: z.string().min(1),
});

// Accept both camelCase and snake_case for projectId to handle frontend naming conventions
const fastBuildBodySchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj["projectId"] === undefined && obj["project_id"] !== undefined) {
        return { ...obj, projectId: obj["project_id"] };
      }
    }
    return raw;
  },
  z.object({
    projectId: z.string().min(1),
    prompt: z.string().min(1).max(4_000),
    attachments: z.array(z.string()).max(10).optional(),
  }),
);

// ── File tree walker ──────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  content: string;
  sizeBytes: number;
  lines: number;
}

async function walkDirectory(base: string, dir: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return entries;
  }
  for (const item of items) {
    const full = join(dir, item);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) {
      entries.push(...await walkDirectory(base, full));
    } else {
      try {
        const content = await readFile(full, "utf8");
        entries.push({
          path: relative(base, full),
          content,
          sizeBytes: s.size,
          lines: content.split("\n").length,
        });
      } catch { /* skip unreadable files */ }
    }
  }
  return entries;
}

// ── Load files from previous build for edit context ───────────────────────────

const MAX_EDIT_CONTEXT_CHARS = 60_000;

async function loadProjectFiles(outputDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    const walked = await walkDirectory(outputDir, outputDir);
    // Prioritise the files the model most needs to see
    const priority = (p: string) =>
      p === "src/App.tsx" ? 0 : p === "src/styles.css" ? 1 : p === "src/index.tsx" ? 2 : 3;
    walked.sort((a, b) => priority(a.path) - priority(b.path));
    let totalChars = 0;
    for (const f of walked) {
      if (totalChars + f.content.length > MAX_EDIT_CONTEXT_CHARS) break;
      files[f.path] = f.content;
      totalChars += f.content.length;
    }
  } catch {
    // filesystem miss (container restart or first build) — fall through
  }

  if (Object.keys(files).length > 0) return files;

  // ── Supabase Storage fallback (Railway redeploy wiped the disk) ───────────
  // outputDir shape: {WORKSPACE_BASE}/{projectId}/{sessionId}/frontend
  // Extract projectId as the first path segment after WORKSPACE_BASE.
  const relToWorkspace = relative(WORKSPACE_BASE, outputDir);
  const projectId = relToWorkspace.split(sep)[0];
  if (!projectId) return files;

  try {
    console.log(`[storage] disk miss — fetching project=${projectId} from Supabase Storage`);
    const downloaded = await downloadProjectFiles(projectId);
    if (Object.keys(downloaded).length === 0) return files;

    // Restore to local disk so subsequent reads (copyExistingFiles, etc.) work.
    await mkdir(outputDir, { recursive: true });
    let totalChars = 0;
    const priority = (p: string) =>
      p === "src/App.tsx" ? 0 : p === "src/styles.css" ? 1 : p === "src/index.tsx" ? 2 : 3;
    const sorted = Object.entries(downloaded).sort(([a], [b]) => priority(a) - priority(b));
    for (const [relPath, content] of sorted) {
      const fullPath = join(outputDir, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
      // Apply same 60KB cap as the normal path so callers get consistent context
      if (totalChars + content.length <= MAX_EDIT_CONTEXT_CHARS) {
        files[relPath] = content;
        totalChars += content.length;
      }
    }
    console.log(`[storage] restored ${Object.keys(files).length} files from Supabase Storage`);
  } catch (err) {
    console.error("[storage] download failed (non-fatal):", err);
  }

  return files;
}

// ── Design token extraction ───────────────────────────────────────────────────

function extractDesignTokens(stylesContent: string): string | null {
  const rootMatch = /(:root\s*\{[^}]+\})/s.exec(stylesContent);
  if (!rootMatch) return null;
  const block = rootMatch[1] ?? "";
  if (!/--[\w-]+\s*:/.test(block)) return null;
  return (
    "# Design System Tokens\n\n" +
    "Persisted CSS variables for this project. Use ONLY these on every build.\n\n" +
    block
  );
}

/** Extract the bare :root { } block from a CSS string, or null if absent/empty. */
function extractRootBlock(css: string): string | null {
  const match = /(:root\s*\{[^}]+\})/s.exec(css);
  if (!match) return null;
  const block = match[1] ?? "";
  return /--[\w-]+\s*:/.test(block) ? block.trim() : null;
}

/**
 * Return true when `css` contains ONLY a :root { } block and no other rules.
 * Used to detect that the LLM correctly output only token values for a token-only edit.
 */
function isRootOnlyCSS(css: string): boolean {
  const stripped = css
    .replace(/(:root\s*\{[^}]+\})/s, "")  // remove :root block
    .replace(/\/\*[\s\S]*?\*\//g, "")      // remove CSS comments
    .trim();
  return stripped.length === 0;
}

/** Compact prompt sent when only the :root token values need updating. */
function buildTokenEditPrompt(rootBlock: string, userRequest: string): string {
  return (
    `EXISTING DESIGN TOKENS:\n${rootBlock}\n\n` +
    `USER REQUEST: ${userRequest}\n\n` +
    `INSTRUCTION: Update ONLY the CSS variable values in the :root block to fulfill the request. ` +
    "Output ONLY the updated :root { } block inside a ```filename:src/styles.css fence — nothing else."
  );
}

// ── Feature addition helpers ──────────────────────────────────────────────────

/**
 * True when the prompt asks to add a new section/component to an existing app.
 * Deliberately narrow — must mention an "add/insert/create" verb AND a UI noun
 * so it doesn't fire on theme changes, data edits, or wording tweaks.
 */
function isAdditionPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const addVerb = /\b(add|insert|include|append|create|build|make)\b/.test(p);
  const uiNoun = /\b(section|component|page|tab|panel|modal|sidebar|navbar|nav|footer|header|widget|form|chart|graph|feature|screen|view|card|list|table|menu|drawer|dialog|tooltip)\b/.test(p);
  const newNoun = /\bnew\s+(section|component|page|tab|panel|modal|sidebar|widget|screen|view|feature)\b/.test(p);
  return (addVerb && uiNoun) || newNoun;
}

/**
 * Extract a compact structural summary of App.tsx.
 * Returns PascalCase component names and direct JSX children of the App return.
 */
function extractAppStructure(appTsx: string): { components: string[]; returnChildren: string[] } {
  const fnRe = /(?:^|\n)\s*(?:function|const)\s+([A-Z][A-Za-z0-9]+)\s*(?:\(|\s*=)/g;
  const components: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(appTsx)) !== null) {
    const name = m[1] ?? "";
    if (name && name !== "App" && !components.includes(name)) components.push(name);
  }
  const returnMatch = /export\s+default\s+function\s+App[\s\S]*?return\s*\(\s*([\s\S]+?)\s*\)\s*;/s.exec(appTsx);
  const returnChildren: string[] = [];
  if (returnMatch) {
    const jsx = returnMatch[1] ?? "";
    const childRe = /<([A-Z][A-Za-z0-9]+)\b[^>]*(?:\/>|>)/g;
    let c: RegExpExecArray | null;
    while ((c = childRe.exec(jsx)) !== null) {
      const name = c[1] ?? "";
      if (name && !returnChildren.includes(name)) returnChildren.push(name);
    }
  }
  return { components, returnChildren };
}

const MAX_APP_TSX_CHARS = 20_000; // ~5K tokens — fallback cap if App.tsx is huge

/**
 * Build prompt for feature-addition mode.
 * Sends a structural summary + the existing App.tsx (capped at ~5K tokens).
 * Explicitly excludes styles.css to prevent theme corruption.
 */
function buildAdditionEditPrompt(appTsx: string, userRequest: string): string {
  const structure = extractAppStructure(appTsx);

  const defined = structure.components.length > 0
    ? structure.components.join(", ")
    : "(no sub-components yet)";
  const renders = structure.returnChildren.length > 0
    ? structure.returnChildren.map((c) => `<${c} />`).join(", ")
    : "(main content inline)";

  const appContent = appTsx.length > MAX_APP_TSX_CHARS
    ? appTsx.slice(0, MAX_APP_TSX_CHARS) + "\n// [truncated — App.tsx too large]"
    : appTsx;

  return (
    `EXISTING APP STRUCTURE:\n` +
    `Components defined: ${defined}\n` +
    `App currently renders: ${renders}\n\n` +
    `EXISTING App.tsx:\n\`\`\`filename:src/App.tsx\n${appContent}\n\`\`\`\n\n` +
    `USER REQUEST: ${userRequest}\n\n` +
    `INSTRUCTION: Add the new feature described above. ` +
    `PRESERVE ALL existing code exactly as-is — only ADD new sections/components. ` +
    `Use existing CSS classes from styles.css — do NOT modify or output styles.css. ` +
    `Output the FULL updated App.tsx — every line, nothing omitted.`
  );
}

/**
 * Validate that an App.tsx string is safe to write.
 * Returns null if valid, or an error message string if not.
 */
function validateAppTsx(code: string): string | null {
  if (!/export\s+default\s+(function\s+App|App\b)/.test(code)) {
    return "Missing `export default function App` — LLM output is incomplete";
  }
  if (/\/\/\s*(BEGIN_EDIT|END_EDIT)\b/.test(code)) {
    return "App.tsx contains unresolved edit markers — refusing to write";
  }
  const opens = (code.match(/\{/g) ?? []).length;
  const closes = (code.match(/\}/g) ?? []).length;
  if (Math.abs(opens - closes) > 3) {
    return `Brace imbalance in App.tsx (opens=${opens} closes=${closes}) — likely truncated output`;
  }
  // Truncation heuristic: last non-whitespace char should close JSX or be a semicolon/brace
  const trimmed = code.trimEnd();
  if (!/[;}\)>]$/.test(trimmed)) {
    return "App.tsx appears truncated — last character suggests incomplete output";
  }
  return null;
}

// ── Image attachment detection ────────────────────────────────────────────────

function hasImageAttachment(attachments?: string[]): boolean {
  if (!attachments || attachments.length === 0) return false;
  return attachments.some((a) => typeof a === "string" && /^data:image\//i.test(a));
}

// ── Agent build detection ─────────────────────────────────────────────────────

function isAgentBuild(prompt: string): boolean {
  return /\b(agent|automat|workflow|daily|hourly|schedul|monitor|track|pipeline|recurring|cron|crewai|crew\s+ai|langgraph|research\s+and|find\s+and|analyz)\b/i.test(prompt);
}

function isAnimationBuild(prompt: string): boolean {
  return /\b(animat(?:ed|ion)|3d.website|3d.character|3d.scene|parallax|scroll.reveal|scroll.animation|landing.page.with.animation|animated.portfolio|interactive.3d|motion.design|gsap|framer.motion|lottie|spline|particle|hero.animation)\b/i.test(prompt);
}

// ── Full-stack detection ──────────────────────────────────────────────────────

/**
 * True when the prompt implies persistence / server logic (auth, CRUD, data
 * storage, etc.) and therefore warrants generating backend + database files.
 */
function needsBackend(prompt: string): boolean {
  // Only trigger fullstack mode when user explicitly mentions auth/database/backend.
  // Simple "todo app", "dashboard", "task manager" should stay frontend-only (Sandpack).
  return /\b(user.auth|login.system|sign.up.flow|real.database|save.to.db|store.in.database|backend.api|server.api|rest.api|multi.user|different.users|user.accounts|real.time.with.websocket|live.updates.from.server|stripe.payment|payment.processing|admin.panel.with.real.data|deploy.with.backend|production.backend|fullstack|full.stack|full-stack|backend|server.side|postgres(?:ql)?|sqlite|mysql|graphql|crud|cloud.sync|signin|signup|oauth|authentication|user.account|user.profile|save.data|store.data|data.storage|nextjs|next\.js|tanstack|fastapi)\b/i.test(prompt);
}

/**
 * True when the prompt explicitly requests a backend runtime that WebContainers
 * cannot run (Python, PHP, Ruby, Go, etc.). Used to short-circuit the build
 * with a helpful redirect message before any LLM tokens are spent.
 */
function isUnsupportedBackendRuntime(prompt: string): boolean {
  return /\b(python|django|flask|fastapi|tornado|bottle|aiohttp|uvicorn|gunicorn|php|laravel|symfony|ruby|rails|sinatra|golang|go lang|rust|actix|elixir|phoenix|java|spring|kotlin|ktor|c\+\+|\.net|asp\.net)\b/i.test(
    prompt,
  );
}

/**
 * True when the prompt implies user accounts, login, OAuth, or session handling.
 * Used to activate the AUTH sub-mode of a fullstack build.
 */
function needsAuth(prompt: string): boolean {
  return /\b(auth|login|log[- ]in|signin|sign[- ]in|sign[- ]up|signup|register|logout|log[- ]out|oauth|jwt|session|password|credential|account|user account|user profile|admin panel|authentication|authorization)\b/i.test(
    prompt,
  );
}

/** Prefix a new-build prompt so PromptBuilder switches into FULLSTACK or FULLSTACK AUTH MODE. */
function buildFullstackPrompt(prompt: string): string {
  const prefix = needsAuth(prompt) ? "FULLSTACK AUTH BUILD:" : "FULLSTACK BUILD:";
  return `${prefix}\n${prompt}`;
}

// ── Smart follow-up file selection ────────────────────────────────────────────

// True when the prompt is about backend/API/server-side concerns.
const BACKEND_INTENT_RE =
  /\b(route|endpoint|api|backend|server|database|db|schema|table|query|migration|webhook|middleware|GET|POST|PUT|DELETE|PATCH)\b|\/[a-z]/i;

// Heuristic: a file is "backend" if its path puts it in server/API/db territory.
function isBackendPath(p: string): boolean {
  return /\b(server|routes?|api|db|database|schema|migrations?|middleware|webhook)\b/i.test(p);
}

/**
 * When backend intent is detected AND a manifest is available, score each
 * manifest line against the prompt's keywords and return the best-matching
 * backend files (up to 3) from existingFiles.
 *
 * Manifest line format:
 *   src/server/routes/todos.ts — Route definitions | exports: api | routes: GET /todos, GET /todos/:id
 *
 * Returns null if the manifest is missing, unparseable, or no backend files match.
 */
function selectBackendFiles(
  files: Record<string, string>,
  prompt: string,
  manifest: string,
): Record<string, string> | null {
  // Extract meaningful keywords from the prompt (3+ chars, not stop words)
  const STOPS = new Set(["the", "a", "an", "for", "to", "in", "of", "and", "or", "with", "add", "make", "create", "update", "fix", "change", "new"]);
  const keywords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9/\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPS.has(w));

  if (keywords.length === 0) return null;

  // Parse manifest lines into scoreable entries (skip header)
  const scores: Array<{ path: string; score: number }> = [];
  for (const line of manifest.split("\n").slice(1)) {
    const dashIdx = line.indexOf(" — ");
    if (dashIdx === -1) continue;
    const filePath = line.slice(0, dashIdx).trim();
    if (!filePath || !(filePath in files)) continue;
    if (!isBackendPath(filePath)) continue;

    // Score this file: path match + route/export match
    const lineText = line.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (filePath.toLowerCase().includes(kw)) score += 10;
      if (lineText.includes(kw)) score += 3;
    }
    if (score > 0) scores.push({ path: filePath, score });
  }

  if (scores.length === 0) return null;

  scores.sort((a, b) => b.score - a.score);
  const selected: Record<string, string> = {};
  for (const { path } of scores.slice(0, 3)) {
    const content = files[path];
    if (content !== undefined) selected[path] = content;
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

/**
 * For short follow-up prompts, select only the 1–2 files likely to change.
 * Also flags theme/color prompts as token-only edits so the caller can send
 * just the :root block instead of the full styles.css.
 *
 * When backend intent is detected and a manifest exists, uses manifest-based
 * scoring to return relevant backend files instead of defaulting to App.tsx.
 */
function selectFollowUpFiles(
  files: Record<string, string>,
  prompt: string,
  manifest: string | null,
): { selected: Record<string, string>; isSmartSelection: boolean; isTokenOnlyEdit: boolean } {
  const p = prompt.toLowerCase();
  const isThemePrompt = /\b(theme|color|colour|dark|light|background|palette|gradient|border|shadow)\b/.test(p);

  // ── Backend intent: try manifest-based selection before frontend defaults ──
  if (!isThemePrompt && BACKEND_INTENT_RE.test(prompt) && manifest) {
    const backendSelected = selectBackendFiles(files, prompt, manifest);
    if (backendSelected !== null) {
      return { selected: backendSelected, isSmartSelection: true, isTokenOnlyEdit: false };
    }
    // No manifest matches — fall through to frontend logic (sends App.tsx as best guess)
  }

  // ── Frontend keyword routing ──────────────────────────────────────────────
  let targetPaths: string[];
  if (isThemePrompt) {
    targetPaths = ["src/styles.css"];
  } else if (/\b(layout|grid|flex|spacing|margin|padding|align|justify)\b/.test(p)) {
    targetPaths = ["src/App.tsx", "src/styles.css"];
  } else if (/\b(text|wording|content|label|title|heading|copy|placeholder|message)\b/.test(p)) {
    targetPaths = ["src/App.tsx"];
  } else {
    targetPaths = ["src/App.tsx"];
  }

  const selected: Record<string, string> = {};
  for (const tp of targetPaths) {
    const fc = files[tp];
    if (fc !== undefined) selected[tp] = fc;
  }

  const isSmartSelection = Object.keys(selected).length > 0;
  // Token-only: theme prompt AND we actually have a styles.css with a :root block
  const isTokenOnlyEdit =
    isThemePrompt &&
    selected["src/styles.css"] !== undefined &&
    extractRootBlock(selected["src/styles.css"] ?? "") !== null;

  return { selected: isSmartSelection ? selected : files, isSmartSelection, isTokenOnlyEdit };
}

// ── Copy directory ────────────────────────────────────────────────────────────

async function copyExistingFiles(srcDir: string, destDir: string): Promise<number> {
  const entries = await walkDirectory(srcDir, srcDir).catch(() => []);
  for (const entry of entries) {
    const destPath = join(destDir, entry.path);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, entry.content, "utf8");
  }
  return entries.length;
}

function buildEditPrompt(files: Record<string, string>, userRequest: string): string {
  const fileBlocks = Object.entries(files)
    .map(([p, c]) => `\`\`\`filename:${p}\n${c}\n\`\`\``)
    .join("\n\n");
  return (
    `EXISTING PROJECT FILES:\n${fileBlocks}\n\n` +
    `USER REQUEST: ${userRequest}\n\n` +
    `INSTRUCTION: Edit the existing files above to fulfill the user request. ` +
    `Keep everything that does not need to change. Output the complete updated files.`
  );
}

/** Detect framework from files already on disk (edit path only). */
function detectFrameworkFromFiles(files: Record<string, string>): FullstackFramework {
  if ("app/routes/__root.tsx" in files) return "tanstack";
  if ("app/layout.tsx" in files || "next.config.js" in files) return "nextjs";
  return "react";
}

/**
 * Like buildEditPrompt but prefixed with FULLSTACK BUILD:/FULLSTACK AUTH BUILD:
 * so PromptBuilder injects the correct NEXTJS_INSTRUCTION / TANSTACK_INSTRUCTION.
 * The framework keyword on line 2 lets detectFullstackFramework() pick it up.
 */
function buildFullstackEditPrompt(
  files: Record<string, string>,
  userRequest: string,
  framework: FullstackFramework,
): string {
  const prefix = needsAuth(userRequest) ? "FULLSTACK AUTH BUILD:" : "FULLSTACK BUILD:";
  const fileBlocks = Object.entries(files)
    .map(([p, c]) => `\`\`\`filename:${p}\n${c}\n\`\`\``)
    .join("\n\n");
  return (
    `${prefix}\n${framework}\n\n` +
    `EXISTING PROJECT FILES:\n${fileBlocks}\n\n` +
    `USER REQUEST: ${userRequest}\n\n` +
    `INSTRUCTION: Edit the existing files above to fulfill the user request. ` +
    `Keep everything that does not need to change. Output the complete updated files.`
  );
}

// ── Background build runner ───────────────────────────────────────────────────

export async function runFastBuild(
  sessionId: string,
  projectId: string,
  prompt: string,
  userId: string,
  hasReferenceImage: boolean = false,
  agentBuildFlag: boolean = false,
  animationFlag: boolean = false,
  projectMemory: string | null = null,
  projectManifest: string | null = null,
): Promise<void> {
  const server = ws();

  // Mark project building + session started (moved from handler hot-path)
  await Promise.all([
    db.update(projects).set({ status: "building" }).where(eq(projects.id, projectId)),
    db.update(buildSessions).set({ startedAt: new Date(), phase: 1 }).where(eq(buildSessions.id, sessionId)),
  ]);

  // ── Emit agent_start ──────────────────────────────────────────────────────
  // Use the actual tier-1 frontend model rather than a hardcoded name so the
  // displayed model stays in sync with MODEL_TIERS.
  const frontendModel = tierModel("frontend", 1);
  server?.agentStart(sessionId, {
    taskId: sessionId,
    sessionId,
    agentType: "frontend",
    taskName: `Fast Build — Frontend (${frontendModel})`,
    model: frontendModel,
    tier: 1,
    timestamp: new Date().toISOString(),
  });

  // ── Unsupported runtime guard ─────────────────────────────────────────────
  // The instant Sandpack preview runs Node.js only — but fullstack builds also
  // get an E2B cloud sandbox preview (a real Linux VM) that can run any backend
  // runtime. So only block Python/PHP/Ruby/Go requests when E2B isn't configured
  // or the prompt won't even produce a backend (nothing would run the code).
  const e2bCanRunNonNodeBackend = Boolean(config.E2B_API_KEY) && needsBackend(prompt);
  if (isUnsupportedBackendRuntime(prompt) && !e2bCanRunNonNodeBackend) {
    const redirectMsg =
      "WebContainers support Node.js only. I can build your backend in Hono.js " +
      "with the same API structure. For Python/PHP/Ruby, use \"Download + Deploy\" " +
      "mode instead.\n\nWould you like me to continue with a Node.js (Hono.js) backend?";
    server?.thinking(sessionId, { text: redirectMsg, sessionId });
    const reason = "Unsupported backend runtime requested. WebContainers run Node.js only.";
    server?.buildFailed(sessionId, {
      sessionId,
      phase: "BUILD",
      reason: redirectMsg,
      logs: "",
      timestamp: new Date().toISOString(),
    });
    await Promise.all([
      db.update(buildSessions)
        .set({ status: "failed", error: reason, completedAt: new Date() })
        .where(eq(buildSessions.id, sessionId)),
      db.update(projects).set({ status: "failed" }).where(eq(projects.id, projectId)),
      refundCredits(userId, FAST_BUILD_CREDIT_COST),
    ]);
    console.log(`[build] unsupported runtime request rejected, credits refunded: ${prompt.slice(0, 80)}`);
    return;
  }

  try {
    // ── Load existing files to decide new-build vs edit-existing ────────────
    // Only load files from a prior build that belongs to THIS project + THIS user
    // and that actually has files on disk (outputDir IS NOT NULL).
    // A brand-new project has no matching row → existingFiles stays {}.
    const lastSuccessRow = await db
      .select({ outputDir: buildSessions.outputDir })
      .from(buildSessions)
      .where(and(
        eq(buildSessions.projectId, projectId),
        eq(buildSessions.userId, userId),
        eq(buildSessions.status, "success"),
        isNotNull(buildSessions.outputDir),
      ))
      .orderBy(desc(buildSessions.createdAt))
      .limit(1);

    const existingFiles = lastSuccessRow[0]?.outputDir
      ? await loadProjectFiles(lastSuccessRow[0].outputDir)
      : {};

    const hasExistingCode = Object.keys(existingFiles).length > 0;
    console.log(`[build] sessionId=${sessionId} hasExistingCode=${hasExistingCode} existingFileCount=${Object.keys(existingFiles).length}`);

    // Start classifier concurrently with follow-up file selection below —
    // only needed for fresh builds; edits keep their existing detection path.
    const classificationPromise = !hasExistingCode
      ? classifyBuild(prompt)
      : Promise.resolve(null);

    // ── Smart follow-up context selection ────────────────────────────────
    // Short prompts (≤ 20 words) on an existing project only need 1–2 files.
    // We copy all existing files to the new outputDir first so unchanged files
    // remain on disk, then let the LLM only re-output what it actually changes.
    const promptWordCount = prompt.trim().split(/\s+/).length;
    const isShortFollowUp = hasExistingCode && promptWordCount <= 20;

    let contextFiles = existingFiles;
    let smartSelectionUsed = false;
    let isTokenOnlyEdit = false;
    let isFeatureAddition = false;

    if (isShortFollowUp) {
      // Feature addition: send ALL files so LLM can output correct full App.tsx.
      // Must be detected before token-only check since theme changes aren't additions.
      if (!isTokenOnlyEdit && isAdditionPrompt(prompt) && existingFiles["src/App.tsx"]) {
        isFeatureAddition = true;
        // contextFiles not used for feature-addition (buildAdditionEditPrompt takes App.tsx directly)
        smartSelectionUsed = true; // ensures copy-existing-files step runs
        const structure = extractAppStructure(existingFiles["src/App.tsx"] ?? "");
        console.log(
          `[build] feature-addition mode: components=[${structure.components.join(", ")}]` +
          ` renders=[${structure.returnChildren.join(", ")}]`,
        );
      } else {
        const { selected, isSmartSelection, isTokenOnlyEdit: tokenOnly } = selectFollowUpFiles(existingFiles, prompt, projectManifest);
        if (isSmartSelection) {
          contextFiles = selected;
          smartSelectionUsed = true;
          isTokenOnlyEdit = tokenOnly;
          console.log(`[build] smart context: ${Object.keys(contextFiles).length}/${Object.keys(existingFiles).length} files → LLM (tokenOnlyEdit=${isTokenOnlyEdit})`);
        }
      }
    }

    // ── Full-stack detection (new builds only) ────────────────────────────
    // Edits and follow-ups keep their existing flows untouched; only a fresh
    // build with no prior code can be promoted to a full-stack generation.
    // classifier was started concurrently above — await result here.
    const classification = await classificationPromise;
    const isFullstackBuild = !hasExistingCode && classification?.buildType === "fullstack";
    const fullstackDb = (isFullstackBuild ? classification?.database : null) ?? "supabase";
    // On the edit path, detect framework from existing files so E2B gets the right
    // template and the AI gets the right instruction (NEXTJS_INSTRUCTION etc.).
    // Falls back to "react" for new builds (hasExistingCode = false).
    const editDetectedFramework: FullstackFramework = hasExistingCode ? detectFrameworkFromFiles(existingFiles) : "react";
    const fullstackFramework: FullstackFramework = ((isFullstackBuild ? classification?.framework : null) as FullstackFramework | null) ?? editDetectedFramework;
    const wantsPython = isFullstackBuild && fullstackFramework === "react" && PYTHON_BACKEND_RE.test(prompt);
    if (isFullstackBuild) {
      console.log(`[build] fullstack mode: generating frontend + backend + db files`);
      // If the user has connected their OWN Supabase (via MCP), point this
      // project's preview at THEIR project; else fall back to the shared
      // preview project. Must be set BEFORE prewarm writes the sandbox .env.
      const userSupa = await getUserSupabasePreviewCreds(userId).catch(() => null);
      setProjectPreviewEnv(projectId, userSupa);
      if (userSupa) console.log(`[build] using owner's connected Supabase for preview project=${projectId}`);
      // Warm the preview sandbox NOW, in the background, so Vite is already
      // running by the time the AI finishes generating.
      prewarmSandbox(projectId, fullstackFramework, (line) =>
        server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line }),
      );
    }
    // All builds use E2B — emit loading immediately so the frontend switches to
    // E2BPreview and shows a spinner during code generation instead of blank screen.
    server?.emitPreviewLoading(sessionId, { sessionId });

    // ── Build task description ────────────────────────────────────────────
    // Priority: token-only > feature-addition > edit-existing > new build.
    const rootBlock = isTokenOnlyEdit
      ? extractRootBlock(existingFiles["src/styles.css"] ?? "")
      : null;

    const taskDescription = rootBlock
      ? buildTokenEditPrompt(rootBlock, prompt)
      : isFeatureAddition
        ? buildAdditionEditPrompt(existingFiles["src/App.tsx"] ?? "", prompt)
        : hasExistingCode
          ? editDetectedFramework !== "react"
            ? buildFullstackEditPrompt(contextFiles, prompt, editDetectedFramework)
            : buildEditPrompt(contextFiles, prompt)
          : isFullstackBuild
            ? buildFullstackPrompt(prompt)
            : expandUserPrompt(prompt);

    const requirements = isTokenOnlyEdit
      ? [
          "Output ONLY ```filename:src/styles.css containing the updated :root { } block.",
          "The file content must be ONLY the :root { } block — no other CSS rules.",
          "Keep ALL existing variable names. Only change the values the user requested.",
          "Do NOT output App.tsx, index.tsx, or package.json.",
        ]
      : isFeatureAddition
        ? [
            "Output ONLY ```filename:src/App.tsx — the full file, every line, nothing omitted.",
            "PRESERVE all existing components, state, and JSX exactly as they are.",
            "Only ADD the new feature — do not restructure or rewrite existing sections.",
            "The file must end with `export default App` or `export default function App`.",
            "Do NOT output src/styles.css, src/index.tsx, or package.json.",
            "Do NOT use // BEGIN_EDIT or // END_EDIT markers.",
          ]
      : hasExistingCode
        ? smartSelectionUsed
          ? [
              "Output ONLY the files you need to change using the exact format: ```filename:src/styles.css",
              "Do NOT output src/index.tsx or package.json if they are unchanged.",
              "For small changes: use surgical edit markers — // BEGIN_EDIT: [desc] ... // END_EDIT",
              "For large changes (>50% of file): output the complete file.",
              "Preserve all existing logic and structure that was not mentioned in the request.",
            ]
          : editDetectedFramework !== "react"
            ? [
                "Output EVERY file you change using the exact format: ```filename:<path> (path in the fence opening).",
                "Keep ALL existing functionality that the user did NOT ask to change.",
                "Preserve the existing design system, color palette, and component structure.",
                "Do NOT output package.json or .env — the environment provides them.",
              ]
            : [
                "Output EVERY file using the exact format: ```filename:src/App.tsx (path in the fence opening).",
                "Always output src/App.tsx, src/index.tsx, and package.json — even if unchanged.",
                "Keep ALL existing functionality that the user did NOT ask to change.",
                "Preserve the existing design system, color palette, and component structure.",
              ]
        : isFullstackBuild
          ? fullstackFramework === "nextjs"
            ? fullstackDb === "mongodb"
              ? [
                  "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                  "Generate ALL of: app/api/[resource]/route.ts (one per resource), app/page.tsx, app/layout.tsx, app/globals.css, src/db/schema.ts, src/lib/db.ts.",
                  "Do NOT generate next.config.ts, next.config.js, src/index.tsx, or src/App.tsx — the environment provides config files and this is NOT a React/Vite project.",
                  "src/db/schema.ts must export Mongoose schemas/models; src/lib/db.ts must export connectDB() per the DATABASE section.",
                  "app/api/*/route.ts: call connectDB() then use Mongoose models — server-side only.",
                  "app/page.tsx is a Server Component — it can call connectDB() + Mongoose directly. Mark sub-components 'use client' only when they need useState/useEffect.",
                  "Do NOT generate a separate src/server/ directory or Hono server — Next.js Route Handlers ARE the backend.",
                  "Do NOT generate package.json or .env — the environment provides them.",
                ]
              : [
                  "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                  "Generate ALL of: app/api/[resource]/route.ts (one per resource), app/page.tsx, app/layout.tsx, app/globals.css, src/db/types.ts, src/db/schema.sql.",
                  "Do NOT generate next.config.ts, next.config.js, src/index.tsx, or src/App.tsx — the environment provides config files and this is NOT a React/Vite project.",
                  "src/db/types.ts must export TypeScript interfaces per table; src/db/schema.sql must have CREATE TABLE + RLS.",
                  "app/api/*/route.ts: use the Supabase service key (server-side only, process.env.SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY) — NEVER import supabase-js in 'use client' components.",
                  "app/page.tsx is a Server Component — it can query Supabase directly (import supabase-js with the service key). Mark sub-components 'use client' only when they need useState/useEffect.",
                  "Do NOT generate a separate src/server/ directory or Hono server — Next.js Route Handlers ARE the backend.",
                  "Do NOT generate package.json or .env — the environment provides them.",
                ]
            : fullstackFramework === "tanstack"
              ? fullstackDb === "mongodb"
                ? [
                    "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                    "Generate ALL of: app/routes/__root.tsx, app/routes/index.tsx, app/client.tsx, app/router.tsx, app/globals.css, app.config.ts, src/db/schema.ts, src/lib/db.ts.",
                    "src/db/schema.ts must export Mongoose schemas/models; src/lib/db.ts must export connectDB() per the DATABASE section.",
                    "Data fetching: use createServerFn (server-side) — call connectDB() + Mongoose inside the server fn. Never call Mongoose from client components.",
                    "For mutations: use createServerFn({ method: 'POST' }) called from event handlers.",
                    "Do NOT generate a separate src/server/ directory or Hono server — TanStack Start server functions ARE the backend.",
                    "Do NOT generate package.json or .env — the environment provides them.",
                  ]
                : [
                    "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                    "Generate ALL of: app/routes/__root.tsx, app/routes/index.tsx, app/client.tsx, app/router.tsx, app/globals.css, app.config.ts, src/db/types.ts, src/db/schema.sql.",
                    "src/db/types.ts must export TypeScript interfaces per table; src/db/schema.sql must have CREATE TABLE + RLS.",
                    "Data fetching: use createServerFn (server-side) — the loader calls the server fn, the component reads Route.useLoaderData(). Never call Supabase from client components directly.",
                    "For mutations: use createServerFn({ method: 'POST' }) called from event handlers.",
                    "Do NOT generate a separate src/server/ directory or Hono server — TanStack Start server functions ARE the backend.",
                    "Do NOT generate package.json or .env — the environment provides them.",
                  ]
              : fullstackDb === "mongodb"
                ? [
                    "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                    "Generate ALL of: src/db/schema.ts, src/lib/db.ts, src/server/index.ts, src/server/routes/api.ts, src/lib/api.ts, src/App.tsx, src/index.tsx.",
                    "Add src/server/routes/auth.ts ONLY if the app needs login/accounts (see AUTH MODE).",
                    "src/App.tsx must have `export default function App()` and fetch data via src/lib/api.ts.",
                    "Backend: Hono.js + Mongoose (MongoDB) — NOT Supabase, NOT @supabase/supabase-js; export const api = new Hono(); routes prefixed /api/; Zod validation.",
                    "src/db/schema.ts must export Mongoose schemas/models for every collection; src/lib/db.ts must export connectDB() per the DATABASE section.",
                    "Do NOT generate package.json or .env — the preview environment provides them with MONGODB_URI wired in.",
                  ]
                : wantsPython
                ? [
                    "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                    "Generate ALL of: src/db/types.ts, src/db/schema.sql, src/lib/api.ts, src/App.tsx, src/index.tsx.",
                    "src/App.tsx must have `export default function App()` and fetch data via src/lib/api.ts.",
                    "Backend: Python FastAPI — see PYTHON BACKEND OVERRIDE section in system prompt for exact files to generate.",
                    "src/db/types.ts must export TypeScript interfaces for every table; src/db/schema.sql must have CREATE TABLE statements for every table.",
                    "Do NOT generate package.json or .env — the preview environment provides them with the Supabase keys wired in.",
                  ]
                : [
                    "Output EVERY file using the exact format: ```filename:<path> (path in the fence opening).",
                    "Generate ALL of: src/db/types.ts, src/db/schema.sql, src/server/index.ts, src/server/routes/api.ts, src/lib/api.ts, src/App.tsx, src/index.tsx.",
                    "src/App.tsx must have `export default function App()` and fetch data via src/lib/api.ts.",
                    "Backend: Hono.js + Supabase (@supabase/supabase-js) — NOT drizzle-orm, NOT any TCP DB driver; export const api = new Hono(); routes prefixed /api/; Zod validation.",
                    "src/db/types.ts must export TypeScript interfaces for every table; src/db/schema.sql must have CREATE TABLE statements for every table.",
                    "Do NOT generate package.json or .env — the preview environment provides them with the Supabase keys wired in.",
                  ]
          : [
              "Output EVERY file using the exact format: ```filename:src/App.tsx (path in the fence opening).",
              "Always include src/App.tsx, src/index.tsx, and package.json.",
              "src/App.tsx must have `export default function App()`.",
            ];

    // ── Tell frontend what's being built (original prompt, never expanded) ──
    server?.thinking(sessionId, { text: `Building: ${prompt}`, sessionId });
    server?.thinking(sessionId, {
      text: hasExistingCode
        ? `Editing existing project (${Object.keys(existingFiles).length} files loaded)...`
        : "Starting new build...",
      sessionId,
    });
    server?.thinking(sessionId, { text: "Calling AI model...", sessionId });

    // ── Dispatch frontend agent ─────────────────────────────────────────────
    const dispatcher = getDispatcher();

    // When a reference image is attached, prepend a pixel-fidelity requirement
    // so it surfaces prominently in the user message alongside the system-prompt
    // instruction injected by buildSystemPrompt().
    const effectiveRequirements = hasReferenceImage
      ? [
          "A reference screenshot/design has been provided. Extract ALL exact hex colors, font sizes, spacing, border-radius, and shadow values from it before writing any code.",
          "Every color and spacing value in your output must exactly match the reference — no approximations.",
          ...requirements,
        ]
      : requirements;

    const result = await dispatcher.dispatch({
      agentType: "frontend",
      task: {
        description: taskDescription,
        requirements: effectiveRequirements,
        outputFormat: "code",
        hasReferenceImage,
        isAgentBuild: agentBuildFlag,
        hasAnimationContext: animationFlag,
        projectMemory,
        projectManifest,
      },
      sessionId,
      userId,
      projectId,
    });

    // ── Check for cancellation ──────────────────────────────────────────────
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      // Tell the client the build actually stopped — the frontend listens for
      // "build:cancelled" to clear its "building" state. Without this the UI
      // hangs forever after the user presses cancel.
      server?.buildCancelled(sessionId);
      return;
    }

    // ── Parse and write files ───────────────────────────────────────────────
    console.log("[DEBUG] LLM output first 500 chars:", result.content.substring(0, 500))
    console.log("[DEBUG] LLM output last 200 chars:", result.content.substring(result.content.length - 200))

    const outputDir = join(WORKSPACE_BASE, projectId, sessionId, "frontend");
    await mkdir(outputDir, { recursive: true });

    // For smart follow-up edits: copy ALL existing files first so unchanged files
    // remain present. LLM output then overwrites only the changed ones.
    if (smartSelectionUsed && lastSuccessRow[0]?.outputDir) {
      const copied = await copyExistingFiles(lastSuccessRow[0].outputDir, outputDir);
      console.log(`[build] copied ${copied} existing files to new outputDir`);
    }

    let parsedFiles: ParsedFile[] = parseFilesFromContent(result.content);

    // Auto-trigger fix agent if frontend produced no structured file output
    if (parsedFiles.length === 0 && result.content.trim().length < 200) {
      logger.warn({ sessionId }, "Frontend agent produced no structured output — triggering fix agent");
      try {
        const fixResult = await dispatcher.triggerFixAgent(
          "frontend",
          `Original prompt: ${prompt}\nAgent response: ${result.content.slice(0, 500)}`,
          sessionId, projectId, userId,
        );
        parsedFiles = parseFilesFromContent(fixResult.content);
      } catch (fixErr) {
        logger.error({ sessionId, fixErr }, "Fix agent also failed");
      }
    }

    // For Next.js/TanStack builds, strip the React boilerplate that
    // parseFilesFromContent auto-injects for Sandpack. These files are
    // meaningless in a Next.js/TanStack project and would be written to the
    // E2B sandbox unnecessarily (src/index.tsx confuses the project structure).
    if (fullstackFramework !== "react") {
      parsedFiles = parsedFiles.filter((f) => f.path !== "src/index.tsx");
    }

    // ── Fail loudly on missing entry point for NEW builds ───────────────────
    // parseFilesFromContent no longer injects a placeholder component when it
    // can't find the entry point — that used to let broken generations silently
    // report "success" with a fake "could not be extracted" component. For a
    // brand-new build (no existing code to fall back on), a missing entry point
    // means the generation genuinely failed: warn the client and abort.
    const expectedEntryPoint =
      fullstackFramework === "nextjs"   ? "app/page.tsx" :
      fullstackFramework === "tanstack" ? "app/routes/index.tsx" :
      "src/App.tsx";
    if (!hasExistingCode && !parsedFiles.some((f) => f.path === expectedEntryPoint)) {
      const msg = `The AI did not produce a valid ${expectedEntryPoint} — generation failed.`;
      logger.error({ sessionId, projectId }, `Parse failure: ${expectedEntryPoint} missing from new build output`);
      server?.emitToRoom(sessionId, "build:warning", {
        sessionId,
        message: msg,
        missingFiles: [expectedEntryPoint],
      });
      throw new Error(msg);
    }

    let filesToWrite: ParsedFile[] =
      parsedFiles.length > 0
        ? parsedFiles
        : [{ path: "output.md", code: result.content }];

    // Fullstack builds must produce non-empty api.ts / db.ts / .env.example /
    // README.md. If any are missing, attempt one focused retry for only those files
    // before continuing — avoids broken deploys without risking infinite loops.
    if (isFullstackBuild) {
      const fileRecord: Record<string, string> = Object.fromEntries(
        filesToWrite.map((f) => [f.path, f.code]),
      );
      const missing = findMissingFullstackFiles(fileRecord, fullstackFramework);
      if (missing.length > 0) {
        logger.warn({ sessionId, missing }, "Fullstack build missing required files — attempting focused retry");
        server?.thinking(sessionId, {
          text: `Retrying generation for missing files: ${missing.join(", ")}`,
          sessionId,
        });

        try {
          const dbLabel = fullstackDb === "mongodb"
            ? "MongoDB (Mongoose — use mongoose models, connectDB() from src/lib/db.ts)"
            : "Supabase PostgreSQL (@supabase/supabase-js — use createClient with env vars)";

          const retryDescription =
            `The following backend/db files were empty or missing from the first build pass and must be generated now:\n` +
            missing.map((f) => `- ${f}`).join("\n") + "\n\n" +
            `App description: ${prompt}\n` +
            `Backend framework: Hono.js on Node.js, port 3001\n` +
            `Database: ${dbLabel}\n\n` +
            `Per-file requirements:\n` +
            (missing.includes("src/db/types.ts") ? "- src/db/types.ts: TypeScript interfaces for every DB table/collection.\n" : "") +
            (missing.includes("src/db/schema.sql") ? "- src/db/schema.sql: CREATE TABLE statements + RLS policies for every table.\n" : "") +
            (missing.includes("src/server/index.ts") ? "- src/server/index.ts: Hono entry point with CORS, mounts api router on /api, serves on port 3001.\n" : "") +
            (missing.includes("src/server/routes/api.ts") ? "- src/server/routes/api.ts: ALL API routes the frontend needs — Zod validation, try/catch on every route.\n" : "");

          const retryResult = await dispatcher.dispatch({
            agentType: "backend",
            task: {
              description: retryDescription,
              requirements: [
                `Output ONLY these files: ${missing.join(", ")} — nothing else.`,
                "Each file must be complete, non-empty, and production-ready.",
                "Use the exact format: \`\`\`filename:<path> for each file.",
                "Do NOT output src/App.tsx, src/index.tsx, or any frontend file.",
              ],
              outputFormat: "code",
            },
            sessionId,
            userId,
            projectId,
          });

          const retryParsed = parseFilesFromContent(retryResult.content);
          const missingSet = new Set(missing);
          const toMerge = retryParsed.filter((f) => missingSet.has(f.path));

          if (toMerge.length > 0) {
            const mergedPaths = new Set(toMerge.map((f) => f.path));
            filesToWrite = [
              ...filesToWrite.filter((f) => !mergedPaths.has(f.path)),
              ...toMerge,
            ];
            logger.info({ sessionId, merged: [...mergedPaths] }, "Fullstack retry: merged recovered files");
          }

          const stillMissing = findMissingFullstackFiles(
            Object.fromEntries(filesToWrite.map((f) => [f.path, f.code])),
            fullstackFramework,
          );
          if (stillMissing.length > 0) {
            logger.warn({ sessionId, stillMissing }, "Fullstack retry: files still missing after retry");
            server?.emitToRoom(sessionId, "build:warning", {
              sessionId,
              message: `Some files could not be generated: ${stillMissing.join(", ")}. Continuing with available files.`,
              missingFiles: stillMissing,
            });
          }
        } catch (retryErr) {
          logger.error({ sessionId, retryErr }, "Fullstack retry dispatch failed");
          server?.emitToRoom(sessionId, "build:warning", {
            sessionId,
            message: `Retry for missing files failed. Continuing with available files. Missing: ${missing.join(", ")}`,
            missingFiles: missing,
          });
        }
      }
    }

    // ── Syntax validation + auto-fix loop ───────────────────────────────────
    // The #1 cause of "Preview failed to load: syntax error" is the model
    // emitting a truncated/broken source file. Parse every generated source
    // file with esbuild (the same parser the preview uses); if any fail, ask
    // the model to return the COMPLETE corrected file, then re-validate. Bounded
    // retries + an error fingerprint prevent loops. Broken code never reaches
    // the preview unless we genuinely can't repair it.
    {
      const MAX_FIX_ATTEMPTS = 2;
      let lastFingerprint = "";
      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const errors = await validateSyntax(filesToWrite).catch(() => []);
        if (errors.length === 0) break;

        const fingerprint = errors.map((e) => `${e.path}:${e.message}`).sort().join("|");
        if (attempt === MAX_FIX_ATTEMPTS || fingerprint === lastFingerprint) {
          // Out of attempts or the same errors keep coming back — surface it
          // instead of shipping broken code as if it succeeded.
          logger.warn({ sessionId, errors }, "Syntax errors remain after fix attempts");
          server?.emitToRoom(sessionId, "build:warning", {
            sessionId,
            message: `Some generated files still have syntax errors: ${errors.map((e) => e.path).join(", ")}. Try a follow-up prompt to fix them.`,
            validationErrors: errors.map((e) => `${e.path}: ${e.message}`),
          });
          break;
        }
        lastFingerprint = fingerprint;

        logger.warn({ sessionId, errors, attempt }, "Syntax errors — dispatching fix");
        server?.thinking(sessionId, {
          text: `Fixing a syntax error in ${errors.map((e) => e.path).join(", ")}…`,
          sessionId,
        });

        const broken = new Set(errors.map((e) => e.path));
        const brokenFiles = filesToWrite.filter((f) => broken.has(f.path));
        const fixDescription =
          `These files have syntax errors that break the preview. Return the COMPLETE corrected file for EACH (no diffs, no truncation):\n\n` +
          brokenFiles
            .map((f) => {
              const errMsg = errors.find((e) => e.path === f.path)?.message ?? "syntax error";
              return `### ${f.path} — error: ${errMsg}\n\`\`\`filename:${f.path}\n${f.code}\n\`\`\``;
            })
            .join("\n\n");

        try {
          const fixResult = await dispatcher.dispatch({
            agentType: "frontend",
            task: {
              description: fixDescription,
              requirements: [
                `Output ONLY these files: ${[...broken].join(", ")}.`,
                "Return each file COMPLETE — never truncate, close every JSX tag and brace.",
                "Use the exact format: ```filename:<path> for each file.",
              ],
              outputFormat: "code",
            },
            sessionId,
            userId,
            projectId,
          });
          const fixedParsed = parseFilesFromContent(fixResult.content);
          const fixedMap = new Map(fixedParsed.filter((f) => broken.has(f.path)).map((f) => [f.path, f.code]));
          if (fixedMap.size > 0) {
            filesToWrite = filesToWrite.map((f) => (fixedMap.has(f.path) ? { ...f, code: fixedMap.get(f.path)! } : f));
          }
        } catch (fixErr) {
          logger.error({ sessionId, fixErr }, "Syntax fix dispatch failed");
          break;
        }
      }
    }

    // ── Validate the parsed file set before writing (Sandpack builds only) ───
    // Catches missing entry points, missing default exports, and server-side
    // imports leaking into browser-bundled files (which would crash Sandpack).
    // Fullstack builds run in E2B (not Sandpack) — skip these checks for them.
    if (!isFullstackBuild) {
      const fileRecord: Record<string, string> = Object.fromEntries(
        filesToWrite.map((f) => [f.path, f.code]),
      );
      const { valid, errors } = validateSandpackFiles(fileRecord);
      if (!valid) {
        logger.warn({ sessionId, errors }, "Sandpack validation found issues in generated files");
        server?.emitToRoom(sessionId, "build:warning", {
          sessionId,
          message: `Validation found issues: ${errors.join("; ")}`,
          validationErrors: errors,
        });
      }
    }

    const writtenPaths: string[] = [];
    const totalFiles = filesToWrite.length;

    for (let idx = 0; idx < filesToWrite.length; idx++) {
      if (cancelledSessions.has(sessionId)) break;

      const file = filesToWrite[idx];
      if (!file) continue;
      const { path: filePath, code } = file;

      // Sanitise path: resolve against the output dir and verify containment —
      // a regex strip of "../" can be bypassed with absolute paths or encoded
      // sequences, but a resolved-path prefix check cannot.
      const fullPath = resolve(outputDir, filePath);
      if (fullPath !== outputDir && !fullPath.startsWith(outputDir + sep)) {
        logger.warn({ sessionId, filePath }, "Path traversal attempt blocked");
        continue;
      }
      const safePath = relative(outputDir, fullPath);
      await mkdir(dirname(fullPath), { recursive: true });

      let finalCode = code;

      // ── CSS protection: reject styles.css for non-theme follow-up edits ───
      // Prevents the LLM from wiping the design tokens on feature additions
      // or text/layout edits. Token-only edits are exempt (they exist to update CSS).
      if (safePath === "src/styles.css" && hasExistingCode && !isTokenOnlyEdit) {
        const isThemePrompt = /\b(theme|color|colour|dark|light|background|palette|gradient|border|shadow)\b/i.test(prompt);
        if (!isThemePrompt) {
          console.log(`[build] CSS file rejected for non-theme edit — keeping existing styles.css`);
          continue;
        }
      }

      // ── Validate App.tsx before writing (feature addition or any edit) ────
      if (safePath === "src/App.tsx" && hasExistingCode) {
        const validationError = validateAppTsx(code);
        if (validationError !== null) {
          console.warn(`[build] App.tsx validation failed: ${validationError}`);
          server?.thinking(sessionId, {
            text: `⚠️ Could not safely apply this change to App.tsx: ${validationError}. Keeping existing file.`,
            sessionId,
          });
          // Keep the existing App.tsx by skipping this file — it was already copied above
          continue;
        }
      }

      // ── Surgical edits (BEGIN_EDIT/END_EDIT markers) ──────────────────────
      const surgicalEdits = parseSurgicalEdits(code);

      if (surgicalEdits.length > 0) {
        // Read the existing file (may have been copied from previous build above)
        let existingCode = "";
        try { existingCode = await readFile(fullPath, "utf8"); } catch { /* new file */ }

        finalCode = existingCode;
        for (const edit of surgicalEdits) {
          finalCode = applySurgicalEdit(finalCode, edit);
        }
        console.log(`[build] applied ${surgicalEdits.length} surgical edit(s) to ${safePath}`);
      } else if (isTokenOnlyEdit && safePath === "src/styles.css") {
        // Token-only mode: LLM outputs just the :root block.
        // Verify it's root-only output, then splice it into the full existing CSS.
        if (isRootOnlyCSS(finalCode)) {
          let existingCSS = "";
          try { existingCSS = await readFile(fullPath, "utf8"); } catch { /* no prior file */ }
          if (existingCSS) {
            finalCode = applySurgicalEdit(existingCSS, { description: "token update", content: finalCode });
            console.log(`[build] token-only edit: spliced new :root block into ${safePath}`);
          }
        } else {
          // LLM output more than the :root block — use it as the full file
          console.log(`[build] token-only: LLM output full CSS (${finalCode.split("\n").length} lines), using as-is`);
        }
      }

      // Strip any stray edit markers so Sandpack never sees // BEGIN_EDIT comments
      finalCode = stripEditMarkers(finalCode);

      // Safety check: warn if styles.css begins with a JS comment after processing
      if (safePath === "src/styles.css" && finalCode.trimStart().startsWith("//")) {
        console.warn(`[build] WARNING: ${safePath} starts with JS comment after edit — possible marker corruption`);
      }

      await writeFile(fullPath, finalCode, "utf8");
      writtenPaths.push(safePath);

      const linesChanged = finalCode.split("\n").length;
      server?.fileUpdate(sessionId, {
        sessionId,
        path: safePath,
        content: finalCode,
        linesChanged,
        timestamp: new Date().toISOString(),
      });

      // Emit file:created for frontend workspace listener
      server?.emitToRoom(sessionId, "file:created", {
        path: safePath,
        content: finalCode,
        sessionId,
      });

      // Emit build:file_write so fullstack clients can track per-file progress
      server?.fileWrite(sessionId, {
        path: safePath,
        isBackend: isBackendFile(safePath),
        sessionId,
      });

      const writePercent = 90 + Math.floor(((idx + 1) / totalFiles) * 10);
      server?.progress(sessionId, {
        sessionId,
        percent: writePercent,
        message: `Writing ${safePath}`,
        timestamp: new Date().toISOString(),
      });
    }

    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      return;
    }

    // ── Save design tokens after every successful build ──────────────────
    // Read the final written styles.css from disk so we get the post-splice content.
    // Path: workspace/{projectId}/DESIGN_TOKENS.md — strictly per-project, not global.
    const finalStylesPath = join(outputDir, "src/styles.css");
    let finalStylesContent = "";
    try { finalStylesContent = await readFile(finalStylesPath, "utf8"); } catch { /* no styles.css */ }
    if (finalStylesContent) {
      const tokensMd = extractDesignTokens(finalStylesContent);
      if (tokensMd !== null) {
        const projectWorkspaceDir = join(WORKSPACE_BASE, projectId);
        const tokensPath = join(projectWorkspaceDir, "DESIGN_TOKENS.md");
        await mkdir(projectWorkspaceDir, { recursive: true });
        await writeFile(tokensPath, tokensMd, "utf8");
        const varCount = (tokensMd.match(/--[\w-]+\s*:/g) ?? []).length;
        // Isolation audit: log exact path so it's easy to verify per-project isolation
        console.log(`[build] design-tokens project=${projectId} vars=${varCount} path=${tokensPath}`);
      }
    }

    // ── Emit build:complete for frontend workspace listener ────────────────
    // Collect final content: for smart-selection builds, merge with existing files
    // so the frontend receives the complete file set (not just what changed).
    const allFiles: Record<string, string> = {};
    if (smartSelectionUsed) {
      // Seed with all files in outputDir (includes copies + LLM output)
      const allOnDisk = await walkDirectory(outputDir, outputDir).catch(() => []);
      for (const f of allOnDisk) allFiles[f.path] = f.content;
    } else {
      for (const f of filesToWrite) {
        allFiles[f.path] = f.code;
      }
    }

    // ── Sync project files to Supabase Storage (survives Railway redeploys) ──
    // For edits: merge existingFiles (pre-build state) with allFiles (LLM output)
    // so unchanged files that the LLM didn't re-emit are not lost in Storage.
    // For fresh builds: existingFiles is {}, so syncMap === allFiles.
    // Fire-and-forget — never blocks the build or preview.
    void (async () => {
      try {
        const syncMap: Record<string, string> = hasExistingCode
          ? { ...existingFiles, ...allFiles }
          : { ...allFiles };
        await uploadProjectFiles(projectId, syncMap);
        console.log(`[storage] synced ${Object.keys(syncMap).length} files project=${projectId}`);
      } catch (err) {
        logger.error({ projectId, sessionId, err }, "[storage] upload failed — next redeploy may lose edit context");
      }
    })();

    // ── Signal backend code is ready with full file contents (fullstack builds) ──
    // NOTE: We generate backend + DB files as code artifacts; we deliberately do
    // NOT execute the generated schema/seed SQL against the platform database.
    // The platform `db` client points at Lampcode's own production DB — running
    // LLM-generated DDL/DML there would be arbitrary SQL execution against prod.
    // Users run these files in their own deployment using the emitted .env.example.
    if (isFullstackBuild) {
      const backendPaths = writtenPaths.filter(isBackendFile);
      server?.backendReady(sessionId, {
        sessionId,
        files: allFiles,
        backendFileCount: backendPaths.length,
        note: "Backend + DB files generated. Run the SQL in src/db/schema.sql against your Supabase project (see .env.example).",
      });
      console.log(`[build] backend_ready project=${projectId} files=[${backendPaths.join(", ")}]`);

      // If the user connected their OWN Supabase via MCP, actually provision it:
      // run the generated schema as a migration against THEIR project so the
      // app's tables/RLS exist. Best-effort + out-of-band — never blocks the
      // build, and only ever touches the user's own project (never the platform
      // DB). We do NOT run generated SQL against any shared/platform database.
      const schemaSql = allFiles["src/db/schema.sql"];
      if (schemaSql && schemaSql.trim()) {
        void getUserSupabaseMcpAuth(userId)
          .then(async (auth) => {
            if (!auth) return;
            server?.emitToRoom(sessionId, "build:preview_log", {
              sessionId,
              line: "Applying schema to your Supabase project…",
            });
            const r = await applySupabaseSchema(auth, `lampcode_${Date.now()}`, schemaSql);
            server?.emitToRoom(sessionId, "build:preview_log", {
              sessionId,
              line: r.ok ? "✅ Schema applied to your Supabase project" : `⚠️ Schema apply failed: ${r.error}`,
            });
          })
          .catch((err) => logger.warn({ projectId, err }, "Supabase schema apply failed"));
      }
    }

    // Filter out backend/server/db files and non-source artifacts before sending
    // to Sandpack. Server-side files import Node.js-only packages that the
    // browser bundler can't resolve. README.md and .env.* are deployment-only.
    // For Next.js/TanStack builds, also exclude package.json: it lists `next`/
    // `vinxi` as dependencies, which Sandpack tries to install from npm and then
    // hangs forever showing "Installing packages…" — the E2B iframe is the real
    // preview for these builds; Sandpack's bundle is irrelevant.
    const frontendFiles = Object.fromEntries(
      Object.entries(allFiles).filter(
        ([p]) =>
          !isBackendFile(p) &&
          !isSandpackExcluded(p) &&
          !(fullstackFramework !== "react" && p === "package.json"),
      ),
    );
    const backendFileCount = Object.keys(allFiles).length - Object.keys(frontendFiles).length;

    // ── Generate AI summary with Haiku (fast, non-blocking path) ─────────────
    let buildSummary = ""
    try {
      const anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
      const fileList = Object.keys(allFiles).slice(0, 20).join(", ")
      const summaryResp = await anthropicClient.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{
          role: "user",
          content: `A web app was just built. Describe it in 1-2 enthusiastic sentences.\nPrompt: "${prompt.slice(0, 300)}"\nFiles: ${fileList}\n\nBe specific about what was built. No preamble, no "Here's" opener.`,
        }],
      })
      const block = summaryResp.content[0]
      if (block?.type === "text") buildSummary = block.text.trim()
    } catch (err) {
      logger.warn({ sessionId, err }, "AI summary generation failed — using fallback")
    }

    server?.buildComplete(sessionId, {
      sessionId,
      files: frontendFiles,       // Sandpack-safe: no Node.js imports
      backendFiles: allFiles,
      backendFileCount,           // >0 signals fullstack build to the client
      previewUrl: null,
      totalFiles: Object.keys(allFiles).length,
      ...(buildSummary ? { summary: buildSummary } : {}),
      ...(!hasExistingCode && classification?.buildType === "frontend"
        ? { hint: "Built with sample data. Say 'add user login and real database' to make it production-ready." }
        : {}),
    });

    // ── Async project memory + manifest update — never blocks the build ────
    setImmediate(() => {
      void (async () => {
        try {
          const allCode = Object.values(allFiles).join("\n")
          const [newMemory, newManifest] = await Promise.all([
            generateProjectMemory(allCode, projectMemory, prompt),
            Promise.resolve(generateFileManifest(allFiles)),
          ])
          try {
            await db.update(projects)
              .set({ projectMemory: newMemory, projectManifest: newManifest })
              .where(eq(projects.id, projectId))
            console.log(`[memory] saved memory+manifest for project ${projectId}`)
          } catch {
            // project_manifest column missing — save memory only until migration runs
            await db.update(projects)
              .set({ projectMemory: newMemory })
              .where(eq(projects.id, projectId))
            console.warn("[memory] saved memory only (project_manifest column missing — run migration 0007)")
          }
        } catch (err) {
          console.error("[memory] update failed:", err)
        }
      })()
    })

    // ── E2B cloud sandbox preview ───────────────────────────────────────────
    // All builds use E2B — React/Vite via lampcode-vite template, fullstack via
    // nextjs/tanstack templates. isFullstackBuild still controls code generation
    // (Hono backend + DB vs pure React), but preview always goes to E2B.
    const wantsE2BPreview = true;

    // Agentic verify-and-fix: after the preview is live, check the real backend
    // actually started. If it crashed, capture the error, re-prompt the model to
    // fix src/server, write the fix back (which restarts the backend), and
    // re-verify. Bounded so it can't loop forever. Then hand back the URL.
    const finishPreview = async (url: string): Promise<void> => {
      const MAX = 2;
      for (let attempt = 0; attempt < MAX; attempt++) {
        const { ok, issues } = await verifyPreview(projectId).catch(() => ({ ok: true, issues: [] as { source: string; message: string }[] }));
        if (ok || issues.length === 0) break;

        const errText = issues.map((i) => `${i.source}: ${i.message}`).join("\n");
        logger.warn({ sessionId, projectId, errText, attempt }, "Backend failed to start — agentic fix");
        server?.thinking(sessionId, { text: "Backend hit an error — fixing it automatically…", sessionId });

        const serverFiles = Object.entries(allFiles).filter(
          ([p]) => p.startsWith("src/server/"),
        );
        if (serverFiles.length === 0) break;
        const fixDesc =
          `The generated backend CRASHED on startup. Fix it and return the COMPLETE corrected file(s) — no diffs, no truncation.\n\n` +
          `Startup error:\n${errText}\n\n` +
          `Current backend files:\n` +
          serverFiles.map(([p, code]) => `\`\`\`filename:${p}\n${code}\n\`\`\``).join("\n\n");

        let fixedCount = 0;
        try {
          const fix = await dispatcher.dispatch({
            agentType: "frontend",
            task: {
              description: fixDesc,
              requirements: [
                "Return each backend file COMPLETE and runnable under tsx.",
                "Keep the server on Number(process.env.PORT) || 3001 and mount routes under /api.",
                "Handle all errors defensively — the server must never throw on startup.",
                "Use the exact format: ```filename:<path> for each file.",
              ],
              outputFormat: "code",
            },
            sessionId,
            userId,
            projectId,
          });
          for (const f of parseFilesFromContent(fix.content)) {
            if (f.path.startsWith("src/server/")) { allFiles[f.path] = f.code; fixedCount++; }
          }
        } catch (fixErr) {
          logger.error({ sessionId, fixErr }, "Backend agentic fix dispatch failed");
          break;
        }
        if (fixedCount === 0) break;
        // Write the fix back — this restarts the backend with the new code.
        await writeFilesToSandbox(projectId, allFiles, (line) =>
          server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line }),
        ).catch(() => {});
      }
      server?.emitPreviewUrl(sessionId, { sessionId, url });
    };

    if (wantsE2BPreview) {
      const sandboxAlreadyRunning = hasSandbox(projectId);
      if (sandboxAlreadyRunning) {
        // Live in this process — push files straight in (Vite HMR refreshes).
        console.log(`[E2B] Follow-up build — writing files directly to running sandbox for project=${projectId}`);
        void writeFilesToSandbox(projectId, allFiles, (line) => {
          server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line });
        })
          .then((url) => {
            console.log(`[E2B] Sandbox files updated for project=${projectId} url=${url}`);
            return finishPreview(url);
          })
          .catch((err) => {
            // Race condition: prewarm sandbox was deleted (dev server timed out) between
            // hasSandbox() returning true and writeFilesToSandbox completing.
            // Fall back to a full cold-start rather than surfacing an error to the user.
            console.warn(`[E2B] Sandbox file write FAILED for project=${projectId} — falling back to full sandbox creation:`, err instanceof Error ? err.message : err);
            logger.warn({ sessionId, projectId, err }, "E2B sandbox file write failed — falling back to createPreviewSandbox");
            server?.emitPreviewLoading(sessionId, { sessionId });
            void createPreviewSandbox(sessionId, projectId, fullstackFramework, allFiles, (line) => {
              server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line });
            })
              .then((url) => {
                console.log(`[E2B] Fallback sandbox ready for session=${sessionId} url=${url}`);
                return finishPreview(url);
              })
              .catch((fallbackErr) => {
                const message = fallbackErr instanceof Error ? fallbackErr.message : "Failed to start preview sandbox";
                console.error(`[E2B] Fallback sandbox FAILED for session=${sessionId}:`, message);
                logger.warn({ sessionId, fallbackErr }, "E2B fallback sandbox failed to start");
                server?.emitPreviewError(sessionId, { sessionId, message });
              });
          });
      } else {
        // Not live in-process — createPreviewSandbox resumes the paused
        // snapshot (or creates fresh for a brand-new fullstack build).
        console.log(`[E2B] Preview needed — queueing createPreviewSandbox for session=${sessionId} files=${Object.keys(allFiles).length} e2bKeyConfigured=${Boolean(config.E2B_API_KEY)}`);
        server?.emitPreviewLoading(sessionId, { sessionId });
        setImmediate(() => {
          console.log(`[E2B] setImmediate fired — calling createPreviewSandbox for session=${sessionId}`);
          void createPreviewSandbox(sessionId, projectId, fullstackFramework, allFiles, (line) => {
            server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line });
          })
            .then((url) => {
              console.log(`[E2B] Preview sandbox ready for session=${sessionId} url=${url}`);
              return finishPreview(url);
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : "Failed to start preview sandbox";
              console.error(`[E2B] Preview sandbox FAILED for session=${sessionId}:`, message);
              logger.warn({ sessionId, err }, "E2B preview sandbox failed to start");
              server?.emitPreviewError(sessionId, { sessionId, message });
            });
        });
      }
    }

    // ── Update build session ────────────────────────────────────────────────
    const creditsUsed = Math.ceil(result.costUsd * 1_000);
    await db
      .update(buildSessions)
      .set({
        status: "success",
        phase: 2,
        outputDir,
        creditsUsed,
        completedAt: new Date(),
      })
      .where(eq(buildSessions.id, sessionId));

    await db
      .update(projects)
      .set({ status: "live" })
      .where(eq(projects.id, projectId));

    // ── Emit complete ───────────────────────────────────────────────────────
    server?.progress(sessionId, {
      sessionId,
      percent: 100,
      message: "Build complete",
      timestamp: new Date().toISOString(),
    });

    server?.phaseComplete(sessionId, {
      sessionId,
      phase: "BUILD",
      nextPhase: null,
      creditsUsed,
      timestamp: new Date().toISOString(),
    });

    logger.info({ sessionId, projectId, files: writtenPaths.length, creditsUsed }, "Fast build complete");
  } catch (err) {
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      return;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ sessionId, err: errorMsg }, "Fast build failed");

    await db
      .update(buildSessions)
      .set({ status: "failed", error: errorMsg, completedAt: new Date() })
      .where(eq(buildSessions.id, sessionId));

    await db
      .update(projects)
      .set({ status: "failed" })
      .where(eq(projects.id, projectId));

    server?.buildFailed(sessionId, {
      sessionId,
      phase: "BUILD",
      reason: errorMsg,
      logs: "",
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const buildRouter = new Hono();
buildRouter.use("/*", requireAuth);

// POST /api/build/clarify
buildRouter.post("/clarify", async (c) => {
  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });

  const parsed = clarifyBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.issues.map(i => i.message).join("; "),
      "VALIDATION_ERROR",
    );
  }
  const { prompt } = parsed.data;

  if (!config.ANTHROPIC_API_KEY) {
    return c.json({ needsClarification: false, questions: [] });
  }

  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: CLARIFY_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Analyze this prompt and generate clarification questions if needed:\n\n${prompt}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");

    try {
      const result = JSON.parse(text) as unknown;
      return c.json(result);
    } catch {
      return c.json({ needsClarification: false, questions: [] });
    }
  } catch (err) {
    logger.warn({ err }, "Clarify endpoint error — skipping clarification");
    return c.json({ needsClarification: false, questions: [] });
  }
});

// POST /api/build/fast
buildRouter.post("/fast", async (c) => {
  const t0 = Date.now();
  const authUser = c.get("authUser");

  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  console.log(`[FAST t+${Date.now()-t0}ms] body parsed`);

  logger.info({
    route: "POST /api/build/fast",
    userId: authUser.id,
    bodyKeys: Object.keys(bodyRaw as object),
    projectId: (bodyRaw as Record<string, unknown>)["projectId"] ?? (bodyRaw as Record<string, unknown>)["project_id"],
    hasPrompt: !!(bodyRaw as Record<string, unknown>)["prompt"],
  }, "fast-build request received");

  const parsed = fastBuildBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    logger.warn({ userId: authUser.id, validationError: msg, bodyKeys: Object.keys(bodyRaw as object) }, "fast-build validation failed");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  const { projectId, prompt, attachments } = parsed.data;

  // ── Verify project ownership ───────────────────────────────────────────────
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, authUser.id)))
    .limit(1);
  const project = projectRows[0];
  console.log(`[FAST t+${Date.now()-t0}ms] project lookup done`);
  if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

  if (project.mode !== "fast") {
    throw new AppError(400, "Project is not in fast mode", "INVALID_MODE");
  }

  if (project.isArchived) {
    throw new AppError(400, "Project is archived", "PROJECT_ARCHIVED");
  }

  if (project.status === "building") {
    throw new AppError(409, "A build is already running for this project", "BUILD_IN_PROGRESS");
  }

  // ── Credit handling (admins bypass entirely) ──────────────────────────────
  const adminBypass = isAdmin(authUser.email);
  if (adminBypass) {
    console.log("[CREDITS] Admin bypass for:", authUser.email);
  } else {
    // Ensure billing row exists with the 500-credit starter limit, then deduct.
    await ensureStartingCredits(authUser.id);
    await deductCredits(authUser.id, FAST_BUILD_CREDIT_COST);
  }
  console.log(`[FAST t+${Date.now()-t0}ms] credits ${adminBypass ? "bypassed" : "deducted"}`);

  const sessionId = randomUUID();
  try {
    // ── Create build session ────────────────────────────────────────────────
    await db.insert(buildSessions).values({
      id: sessionId,
      projectId,
      userId: authUser.id,
      prompt,
      mode: "fast",
      status: "running",
      phase: 0,
      attachments: attachments ?? null,
    });
    console.log(`[FAST t+${Date.now()-t0}ms] session created id=${sessionId}`);

    // ── Fire-and-forget build ───────────────────────────────────────────────
    const userId = authUser.id;
    const refImgFlag = hasImageAttachment(attachments);
    const agentFlag = isAgentBuild(prompt);
    const animationFlag = isAnimationBuild(prompt);

    // Fetch project memory + manifest before kicking off the build.
    // Defensive: if project_manifest column doesn't exist yet (migration pending),
    // catch the DB error and fall back to querying projectMemory only so the build
    // still completes. Manifest will be null until the migration runs.
    let memoryFlag: string | null = null;
    let manifestFlag: string | null = null;
    try {
      const projectRow = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { projectMemory: true, projectManifest: true },
      });
      memoryFlag = projectRow?.projectMemory ?? null;
      manifestFlag = projectRow?.projectManifest ?? null;
    } catch {
      // Column project_manifest doesn't exist yet — run: drizzle-kit migrate
      const memRow = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { projectMemory: true },
      });
      memoryFlag = memRow?.projectMemory ?? null;
      console.warn("[build] project_manifest column missing — run migration 0007_project_manifest.sql");
    }

    setImmediate(() => {
      void (async () => {
        // Action mode: route to the MCP action agent when the prompt looks like
        // a direct action OR contains a reference URL (Firecrawl is always available).
        const hasReferenceUrl = URL_REGEX.test(prompt);
        if (ACTION_MODE_RE.test(prompt) || hasReferenceUrl) {
          const [mcpServers, restProviders] = await Promise.all([
            getConnectedMcpServers(userId).catch(() => []),
            getConnectedRestProviders(userId).catch(() => []),
          ]);
          // Route if user has connected MCPs OR if a URL is present (firecrawl handles it)
          if (mcpServers.length > 0 || restProviders.length > 0 || hasReferenceUrl) {
            return runMcpAction({ sessionId, userId, prompt, mcpServers, restProviders, hasReferenceUrl }).catch((err) => {
              console.error("[mcp-action] error:", err);
              if (!adminBypass) refundCredits(userId, FAST_BUILD_CREDIT_COST).catch(console.error);
            });
          }
        }
        // Default: normal code-generation build
        return runFastBuild(sessionId, projectId, prompt, userId, refImgFlag, agentFlag, animationFlag, memoryFlag, manifestFlag).catch((err) => {
          console.error(err);
          if (!adminBypass) refundCredits(userId, FAST_BUILD_CREDIT_COST).catch(console.error);
        });
      })();
    });
  } catch (err) {
    // Refund credits if session creation failed (DB insert or project update)
    if (!adminBypass) await refundCredits(authUser.id, FAST_BUILD_CREDIT_COST);
    throw err;
  }

  return c.json({ sessionId, status: "running", projectId });
});


// GET /api/build/:projectId/last-session
buildRouter.get("/:projectId/last-session", async (c) => {
  const authUser = c.get("authUser");
  const { projectId } = c.req.param();

  const rows = await db
    .select({ sessionId: buildSessions.id, status: buildSessions.status })
    .from(buildSessions)
    .where(and(eq(buildSessions.projectId, projectId), eq(buildSessions.userId, authUser.id)))
    .orderBy(desc(buildSessions.createdAt))
    .limit(1);

  if (!rows.length) return c.json({ sessionId: null });
  return c.json({ sessionId: rows[0]!.sessionId, status: rows[0]!.status });
});

// GET /api/build/:projectId/sessions — list recent sessions for a project (most recent first)
buildRouter.get("/:projectId/sessions", async (c) => {
  const authUser = c.get("authUser");
  const { projectId } = c.req.param();

  const rows = await db
    .select({
      id: buildSessions.id,
      status: buildSessions.status,
      prompt: buildSessions.prompt,
      creditsUsed: buildSessions.creditsUsed,
      createdAt: buildSessions.createdAt,
      completedAt: buildSessions.completedAt,
    })
    .from(buildSessions)
    .where(and(eq(buildSessions.projectId, projectId), eq(buildSessions.userId, authUser.id)))
    .orderBy(desc(buildSessions.createdAt))
    .limit(20);

  return c.json({ sessions: rows });
});

// GET /api/build/:sessionId/status
buildRouter.get("/:sessionId/status", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  // Fetch agent tasks for this session
  const tasks = await db
    .select({
      agentType: agentTasks.agentType,
      status: agentTasks.status,
      inputTokens: agentTasks.inputTokens,
      outputTokens: agentTasks.outputTokens,
    })
    .from(agentTasks)
    .where(eq(agentTasks.sessionId, sessionId));

  const agents = tasks.map((t) => ({
    type: t.agentType,
    status: t.status,
    progress: t.status === "complete" ? 100 : t.status === "failed" ? 0 : 50,
    tokens: (t.inputTokens ?? 0) + (t.outputTokens ?? 0),
  }));

  return c.json({
    sessionId,
    phase: session.phase,
    status: session.status,
    agents,
    creditsUsed: session.creditsUsed,
    outputDir: session.outputDir,
    previewUrl: session.previewUrl,
    error: session.error,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  });
});

// POST /api/build/:sessionId/cancel
buildRouter.post("/:sessionId/cancel", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  if (session.status !== "running") {
    throw new AppError(409, `Build is already ${session.status}`, "BUILD_NOT_RUNNING");
  }

  // Signal the background runner to stop before writing the next file
  cancelledSessions.add(sessionId);

  // Tear down any E2B preview sandbox tied to this session — otherwise it
  // keeps running (and billing) until E2B's own 30-minute idle timeout.
  killSandbox(session.projectId).catch((err) => {
    logger.warn({ sessionId, projectId: session.projectId, err }, "Failed to kill preview sandbox on cancel");
  });

  // Update DB immediately
  await db
    .update(buildSessions)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(buildSessions.id, sessionId));

  await db
    .update(projects)
    .set({ status: "live" })
    .where(eq(projects.id, session.projectId));

  // Best-effort: delete partial workspace files
  const partialDir = join(WORKSPACE_BASE, session.projectId, sessionId);
  rm(partialDir, { recursive: true, force: true }).catch(() => undefined);

  ws()?.buildFailed(sessionId, {
    sessionId,
    phase: "BUILD",
    reason: "Cancelled by user",
    logs: "",
    timestamp: new Date().toISOString(),
  });

  return c.json({ sessionId, status: "cancelled" });
});

// GET /api/build/:sessionId/files
buildRouter.get("/:sessionId/files", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  if (session.outputDir === null) {
    return c.json({ sessionId, files: [], message: "No files written yet" });
  }

  const workspaceBase = join(WORKSPACE_BASE, session.projectId, sessionId);
  const files = await walkDirectory(workspaceBase, workspaceBase);

  // Group by subdirectory (frontend / backend)
  const grouped: Record<string, typeof files> = {};
  for (const f of files) {
    const segments = f.path.split("/");
    const bucket = segments.length > 1 ? (segments[0] ?? "root") : "root";
    const existing = grouped[bucket];
    if (existing) {
      existing.push(f);
    } else {
      grouped[bucket] = [f];
    }
  }

  return c.json({
    sessionId,
    totalFiles: files.length,
    totalSizeBytes: files.reduce((acc, f) => acc + f.sizeBytes, 0),
    groups: grouped,
  });
});

// POST /api/build/:projectId/memory — persist a rule into MEMORY_RULES.md
// Injected on every future build via PromptBuilder reading workspace/{projectId}/MEMORY_RULES.md
buildRouter.post("/:projectId/memory", async (c) => {
  const authUser = c.get("authUser");
  const { projectId } = c.req.param();

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const ruleSchema = z.object({ rule: z.string().min(1).max(1_000) });
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, "rule must be a non-empty string (max 1000 chars)", "VALIDATION_ERROR");

  // Verify project ownership
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, authUser.id)))
    .limit(1);
  if (!projectRows[0]) throw new AppError(404, "Project not found", "NOT_FOUND");

  const rulesPath = join(WORKSPACE_BASE, projectId, "MEMORY_RULES.md");
  let existing = "";
  try { existing = await readFile(rulesPath, "utf8"); } catch { /* first rule */ }

  const newContent = existing.trim()
    ? `${existing.trim()}\n- ${parsed.data.rule}\n`
    : `# Project Memory Rules\n\n- ${parsed.data.rule}\n`;

  await mkdir(join(WORKSPACE_BASE, projectId), { recursive: true });
  await writeFile(rulesPath, newContent, "utf8");

  const totalRules = (newContent.match(/^- /gm) ?? []).length;
  // Isolation audit: log exact path so it's easy to verify per-project isolation
  console.log(`[build] memory-rule project=${projectId} totalRules=${totalRules} path=${rulesPath}`);
  logger.info({ projectId, rule: parsed.data.rule, totalRules }, "Memory rule saved");
  return c.json({ ok: true, totalRules });
});
