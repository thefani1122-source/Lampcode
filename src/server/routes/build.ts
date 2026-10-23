Warning: truncated output (original token count: 67241)
Total output lines: 5314

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc, isNotNull, inArray } from "drizzle-orm";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "fs/promises";
import { join, dirname, relative, resolve, sep } from "path";
import { db } from "../../db/client.js";
import {
  projects,
  buildSessions,
  agentTasks,
  type BuildOutcome,
  type BuildPlan,
  type CompletionAudit,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getDispatcher } from "../../agents/dispatcher.js";
import { currentProjectFiles } from "../../agents/file-deletion.js";
import { tierModel } from "../../agents/model-gateway.js";
import { detectDatabase, detectFullstackFramework, expandUserPrompt, PYTHON_BACKEND_RE, type FullstackFramework } from "../../agents/prompt-builder.js";
import { validateSyntax } from "../../agents/syntax-check.js";
import {
  parseFilesFromContent,
  applyParsedFiles,
  findMissingFullstackFiles,
  validateSandpackFiles,
  parseSurgicalEdits,
  applySurgicalEdit,
  stripEditMarkers,
  isBackendFile,
  isSandpackExcluded,
  isEffectivelyEmpty,
  extractBuildSummary,
  type ParsedFile,
} from "../../agents/file-parser.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";
import { assertHasBudget, getUserPlan } from "../../build/credits.js";
import { isAdmin } from "../../auth/admin.js";
import { recordUserPrompt } from "../../websocket/message-recorder.js";
import { capturePreviewScreenshot, captureStorage, checkInteractions, runTests, createPreviewSandbox, killSandbox, hasSandbox, hasSandboxRecord, writeFilesToSandbox, prewarmSandbox, setProjectPreviewEnv, verifyPreview, runTypeCheck, verifyBrowserRender, isTemplateOwnedFile } from "../../preview/e2b-service.js";
import { getUserSupabasePreviewCreds, getUserSupabaseMcpAuth, getConnectedMcpServers, getUserVercelDeployToken } from "./integrations.js";
import { applySupabaseSchema } from "../../mcp/supabase-mcp.js";
import { config } from "../config.js";
import { declaredTables, fakePersistence, findDataLayerGaps, formatDataLayerForUser, formatDataLayerGaps, queriedTables, schemaRepairInstruction, undeclaredTables } from "../../verify/data-layer.js";
import { extractThreats, formatThreatsForModel, formatThreatsForUser, type ThreatExtractResult, type ThreatRequirement } from "../../verify/threat-model.js";
import { serversForPrompt } from "../../agents/mcp-relevance.js";
import { ANSWER_TIMEOUT_MS, createPendingAnswer } from "../../agents/pending-answers.js";
import {
  buildDatabaseQuestion,
  interpretDatabaseAnswer,
  shouldAskForDatabase,
} from "../database-prompt.js";
import Anthropic from "@anthropic-ai/sdk";
import { generateProjectMemory } from "../../agents/memory-generator.js";
import { generateFileManifest, findOrphanExports, type OrphanExport } from "../../agents/manifest-generator.js";
import { runSecurityChecks, type SecurityCheck, type SecurityReport, type FileTree } from "../../verify/security.js";
import { uploadProjectFiles, downloadProjectFiles, uploadPreviewScreenshot, persistFilesAsWritten } from "../../storage/project-files.js";
import { classifyBuild } from "../../agents/build-classifier.js";
import { shouldPlan, planBuild, formatPlanForPrompt } from "../../agents/build-planner.js";
import { findDeadCode, formatDeadCode, tallyDeadCode, type DeadCodeKind } from "../../verify/dead-code.js";
import { findBrokenImports, formatBrokenImports } from "../../verify/import-graph.js";
import { findArchitectureGaps, formatArchitectureGaps, type ArchitectureKind } from "../../verify/architecture.js";
import { auditRepairInstruction, describeRepair, formatFilesForRepair, judgeRepair, planAuditRepair, repairStatusLine, whyNoRepair, type RepairOutcome } from "../../verify/audit-repair.js";
import { BuildEventRecorder } from "../build-events.js";
import { projectOutcome } from "../../verify/outcome-projection.js";
import {
  findWiringGaps,
  tallyWiringGaps,
  repairableGaps,
  formatWiringGaps,
  formatWiringForUser,
  declaredRoutes,
} from "../../verify/wiring.js";
import {
  findHollowTests,
  tallyHollowTests,
  formatHollowTestsForUser,
} from "../../verify/hollow-tests.js";
import { tallyInteractions, formatInteractionsForUser } from "../../verify/interactions.js";
import type { StorageSnapshot } from "../../verify/storage.js";
import { routesToVisit } from "../../verify/render.js";
import { formatPreviewEmailConfirmationGuidance } from "../../verify/preview-auth-guidance.js";
import {
  shouldAudit,
  extractCriteria,
  auditCompletion,
  discountFakedEvidence,
  unverifiedAudit,
  formatAuditForUser,
  formatCriteriaForUser,
  type ExtractResult,
} from "../../verify/completion-audit.js";

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

const WORKSPACE_BASE = join(process.cwd(), "workspace");

// Hard ceiling on cumulative model spend within one build (main dispatch +
// missing-files retry + fix loops). Checked BETWEEN dispatches, never mid-stream —
// a single dispatch already in flight always completes. Protects against the
// retry/fix loops compounding spend beyond what the flat credit charge represents.
const MAX_BUILD_COST_USD = process.env["MAX_BUILD_COST_USD"]
  ? parseFloat(process.env["MAX_BUILD_COST_USD"])
  : 1.0;

// ── In-memory cancel registry ─────────────────────────────────────────────────

const cancelledSessions = new Set<string>();

// Sessions this process is currently building. Only this process's own, so a
// second replica's builds are never touched.
const runningSessions = new Set<string>();

/**
 * Fail every build this process is still running, and tell its client.
 *
 * Called on SIGTERM. Without it a redeploy or restart kills the container
 * mid-build and nothing says so: the row stays `running` forever, no
 * build:failed is emitted, and the user watches a spinner that will never
 * resolve. Observed live — a deploy landed eight seconds into an agency-site
 * build and the build simply vanished.
 *
 * Deliberately says the build was interrupted rather than that it failed,
 * because nothing was wrong with it.
 */
export async function failRunningBuildsOnShutdown(): Promise<void> {
  const sessions = [...runningSessions];
  if (sessions.length === 0) return;
  logger.warn({ sessions }, "Shutting down with builds in flight — failing them so clients don't hang");

  const server = ws();
  const reason = "The server restarted while this build was running. Nothing was saved — please run it again.";

  for (const sessionId of sessions) {
    server?.buildFailed(sessionId, {
      sessionId,
      phase: "BUILD",
      reason,
      logs: "",
      timestamp: new Date().toISOString(),
    });
  }

  await db
    .update(buildSessions)
    .set({ status: "failed", error: reason, completedAt: new Date() })
    .where(inArray(buildSessions.id, sessions))
    .catch((err: unknown) => {
      logger.error({ err }, "Could not mark in-flight builds as failed during shutdown");
    });
}

// ── WS helper — never throws ──────────────────────────────────────────────────

function ws() {
  try {
    return getWebSocketServer();
  } catch (err) {
    logger.error({ err }, "WebSocketServer not initialised — build events will not be emitted");
    return null;
  }
}

// ── Preview-sandbox outer deadline ──────────────────────────────────────────────
// createPreviewSandbox() has no timeout of its own (the E2B SDK's per-request
// timeout only covers a single HTTP call, not the whole create+writeFiles+
// ensureDevServer chain) — if the E2B API stalls, the call can hang
// indefinitely with no error, log, or preview URL, while the frontend just
// gives up after its own 120s poll with a generic message. This race gives it
// a deadline so a stall surfaces as a real, logged error instead.
const E2B_PREVIEW_TIMEOUT_MS = 90_000;

/**
 * How long the database question waits before building without one.
 *
 * The shared ANSWER_TIMEOUT_MS is TEN MINUTES, which is right for a write
 * approval — "may I push to your GitHub?" should wait, because guessing is
 * worse than waiting. It is wrong here. Someone who ignores or misses this card
 * gets a build that sits silent for ten minutes with no explanation, and the
 * answer to "no reply" is not dangerous: build it without a database and say
 * so, which is exactly what the fall-through below does.
 *
 * Two minutes is long enough to read a card and click, short enough that a
 * person who walked away still gets their app.
 */
const DB_GATE_TIMEOUT_MS = 120_000;

/** Long enough for a migration against a cold Supabase, short enough that a
 *  wedged one does not hold the build. */
const SCHEMA_APPLY_TIMEOUT_MS = 45_000;

// The three sandbox quality gates deliberately fail OPEN: a gate that itself
// errors must never fail a build that was already delivered to the user. That
// is still right, but it used to be entirely silent, so a gate erroring looked
// exactly like a gate passing. Same fallback, now visible.
function gateFailedOpen(
  gate: string,
  sessionId: string,
  projectId: string,
  err: unknown,
): { ok: boolean; issues: { source: string; message: string }[]; unavailable: boolean } {
  logger.warn({ sessionId, projectId, gate, err }, "Sandbox quality gate errored — failing open, build is UNVERIFIED");
  return { ok: true, issues: [], unavailable: true };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err as Error); },
    );
  });
}

// ── Input schemas ─────────────────────────────────────────────────────────────

// 4,000 characters turned out to be roughly 3,100 for the person typing: the
// workspace composer appends SANDBOX_PREVIEW_CONSTRAINTS (~890 chars) and any
// clarifying answers to every prompt before it is sent, and the limit applies
// to the total. A detailed brief for an app — the thing this product is for —
// goes past that easily, and the only signal was a 400.
//
// 16,000 characters is about 4,000 tokens, which is nothing beside the build
// it starts, and spend is already bounded by the credit check and
// MAX_BUILD_COST_USD rather than by how much someone typed.
const MAX_PROMPT_CHARS = 16_000;

const clarifyBodySchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
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
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
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
  // three.js/webgl/r3f are here because the block this gates carries the
  // full-bleed-canvas rule, and a prompt can ask for a WebGL scene without
  // using any of the motion words — "a landing page with a Three.js globe"
  // matched nothing, so the one build that most needs the stacking-context
  // warning was the one that never saw it.
  return /\b(animat(?:ed|ion)|3d.website|3d.character|3d.scene|parallax|scroll.reveal|scroll.animation|landing.page.with.animation|animated.portfolio|interactive.3d|motion.design|gsap|framer.motion|lottie|spline|particle|hero.animation|three\.?js|webgl|r3f|react.three)\b/i.test(prompt);
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
/**
 * Security findings that must never be auto-fixed: a leaked secret can't be
 * "fixed" by rewriting the line that exposed it (the credential is already
 * compromised), and declaring an undeclared/possibly-hallucinated package as
 * a real dependency risks entrenching a slopsquatted package rather than
 * removing it. Everything else (missing auth/RLS/CORS/CSRF/XSS/SQLi guard,
 * missing Stripe webhook verification) is a well-defined code pattern an
 * auto-fix dispatch can safely attempt.
 */
function isHardBlockSecurityCheck(c: SecurityCheck): boolean {
  return c.id.startsWith("secret-") || c.id.startsWith("packages-undeclared-");
}

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

/** How many times the model called each tool, across every round of a dispatch.
 *  Part of the build's outcome record: if check_page barely appears here, the
 *  agent is not verifying its own work whatever the prompt says. */
function countToolCalls(calls: Array<{ name: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  return counts;
}

/**
 * Thrown to skip the post-completion reconciliation, never to fail anything.
 *
 * The reconciliation exists only for the old ordering, where the record was
 * written before the repair loops ran. A named sentinel rather than a flag
 * check at every step: the block is a single try/catch and this keeps the
 * "nothing to do" path from being mistaken for a failed write in the log.
 */
class SkipReconciliation extends Error {}

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
  // Registered before anything can throw and cleared in the finally at the very
  // end, so a shutdown at any point in between can still find and close it out.
  runningSessions.add(sessionId);
  // Wall clock for the whole build, for buildOutcome below. completedAt minus
  // startedAt would be close, but startedAt is written a few awaits later and
  // both are DB round-trips.
  const buildStartedMs = Date.now();

  // Outcome evidence, captured as soon as the generation dispatch returns and
  // refined at the end. Declared out here so the catch can write it too: a
  // build that FAILED is the case you most want rounds and gate results for,
  // and the completion block never runs on that path.
  let outcomeDraft: BuildOutcome | null = null;

  // The ordered record of what this build did (C1/C2). Appended to as the build
  // runs and flushed at each boundary, so a build that dies — a redeploy, an
  // OOM, a throw past the catch — still leaves the evidence it had reached.
  // Folded into the outcome's core at the end by projectOutcome().
  const recorder = new BuildEventRecorder(sessionId);

  // What happened when the generated schema met the user's database. Absent on
  // frontend builds; `ran: false` when a schema was written and there was no
  // database to apply it to, which is the single most common reason a
  // "fullstack" app saves nothing.
  let schemaApply: { ran: boolean; ok: boolean; error?: string } | null = null;

  // What happened when the build went back to finish what the audit said was
  // missing. Null when no repair was attempted — which is the normal case, and
  // a different fact from one that was attempted and achieved nothing.
  let auditRepair: NonNullable<BuildOutcome["auditRepair"]> | null = null;

  // Which gateway this build uses. LLM_PROVIDER_MODE overrides the per-plan
  // routing outright — without it a paid or admin account can never exercise
  // the OpenAI-compatible model the product is meant to run on, because the
  // plan silently sends it to Anthropic instead.
  const provider: "anthropic" | "modal" =
    config.LLM_PROVIDER_MODE === "openai"
      ? "modal"
      : config.LLM_PROVIDER_MODE === "anthropic"
        ? "anthropic"
        : await getUserPlan(userId)
            .then((plan) => (plan === "free" ? "modal" : "anthropic"))
            // Paid-gateway behavior is the safe default on a lookup failure —
            // never silently drop a paid user onto the free-tier model.
            .catch(() => "anthropic");

  console.log(
    `[build] provider=${provider} (mode=${config.LLM_PROVIDER_MODE}) session=${sessionId}`,
  );

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
    ]);
    // Nothing to refund — no dispatch ran before this rejection, so no real
    // usage was incurred (usage is deducted per-dispatch, not pre-charged).
    console.log(`[build] unsupported runtime request rejected, no usage incurred: ${prompt.slice(0, 80)}`);
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

    // Whether this build must carry the project's prior files forward. Every
    // edit does — the output format has no way to express a deletion, so a file
    // the model doesn't re-emit is unchanged, never removed. This used to be
    // tied to smartSelectionUsed, which is only ever set for follow-ups of <= 20
    // words; a longer follow-up therefore copied nothing, rebuilt allFiles from
    // this turn's output alone, and was saved as the new success outputDir that
    // the NEXT edit reads from — silently dropping every file the model hadn't
    // re-emitted. The Supabase Storage copy couldn't recover it either, since
    // that fallback only fires when the directory is completely empty.
    // Deliberately separate from smartSelectionUsed, which still (correctly)
    // controls only the output-format instructions given to the model.
    const preserveExistingFiles = hasExistingCode && Boolean(lastSuccessRow[0]?.outputDir);

    // Start classifier concurrently with follow-up file selection below —
    // only needed for fresh builds; edits keep their existing detection path.
    // The dispatcher is passed so the AMBIGUOUS middle gets read rather than
    // guessed. Explicit prompts ("store it in Supabase", "in localStorage")
    // never reach the model and cost nothing; only a request that names neither
    // pays for one small call, concurrently with the file selection below.
    //
    // That call needs a REAL token budget. Measured 2026-10-21: minimax-m2.5
    // puts its reasoning in its own field and leaves `content` null until that
    // is finished — at 400 tokens it returned `finish_reason: "length"` and no
    // JSON at all, nine times out of nine. At the dispatcher's budget it was
    // right on nine of nine. Anyone "optimising" this pass with a small budget
    // will silently turn every ambiguous build back into a browser app.
    const classificationPromise = !hasExistingCode
      ? classifyBuild(prompt, {
          dispatcher: getDispatcher(),
          sessionId,
          userId,
          projectId,
          provider,
        })
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
    // Logged on every fresh build, including the frontend ones. This one
    // decision silently governs whether a backend is written at all, whether
    // the database gate fires, and what the prompt tells the model — and when
    // it is wrong nothing downstream can recover. `source` says whether a word
    // decided it, a model read it, or it was a lean.
    if (classification) {
      console.log(
        `[build] classified session=${sessionId} type=${classification.buildType} ` +
        `source=${classification.source} auth=${classification.needsAuth} ` +
        `db=${classification.database} reason="${classification.reason}"`,
      );
    }
    const isFullstackBuild = !hasExistingCode && classification?.buildType === "fullstack";
    const fullstackDb = (isFullstackBuild ? classification?.database : null) ?? "supabase";
    // On the edit path, detect framework from existing files so E2B gets the right
    // template and the AI gets the right instruction (NEXTJS_INSTRUCTION etc.).
    // Falls back to "react" for new builds (hasExistingCode = false).
    const editDetectedFramework: FullstackFramework = hasExistingCode ? detectFrameworkFromFiles(existingFiles) : "react";
    const fullstackFramework: FullstackFramework = ((isFullstackBuild ? classification?.framework : null) as FullstackFramework | null) ?? editDetectedFramework;
    const wantsPython = isFullstackBuild && fullstackFramework === "react" && PYTHON_BACKEND_RE.test(prompt);
    // Whether the generated schema has anywhere to land. Hoisted out of the
    // block below because the data-layer check at the end of the build needs
    // it: applying `schema.sql` only ever happens against a Supabase the user
    // connected themselves, so this flag IS "the app's tables will exist".
    let ownSupabaseConnected = false;
    if (isFullstackBuild) {
      console.log(`[build] fullstack mode: generating frontend + backend + db files`);
      // If the user has connected their OWN Supabase (via MCP), point this
      // project's preview at THEIR project; else fall back to the shared
      // preview project. Must be set BEFORE prewarm writes the sandbox .env.
      let userSupa = await getUserSupabasePreviewCreds(userId).catch(() => null);

      // No database of their own, and a full-stack app is about to be built on
      // top of nothing. Ask now, because the sandbox .env is written during
      // prewarm below and a project connected after that arrives too late to
      // change what the app points at.
      //
      // The answer is never trusted — it only ends the wait. What decides is
      // re-reading the integration, so "done" from someone who did not finish
      // the flow lands exactly where declining does, with no false promise of
      // persistence.
      // `server &&` comes before the once-per-project check on purpose: with no
      // socket there is nobody to ask, and consuming the single ask on a
      // question that was never shown would mean the person is never asked at
      // all — a gate that silently spends itself is worse than no gate.
      if (!userSupa && server && shouldAskForDatabase(userId)) {
        const { question, options } = buildDatabaseQuestion();
        const toolCallId = `db-gate:${randomUUID()}`;
        const answer = await new Promise<string | null>((resolve) => {
          let settled = false;
          const done = (v: string | null) => {
            if (settled) return;
            settled = true;
            resolve(v);
          };
          try {
            void createPendingAnswer(toolCallId, sessionId).then(done);
            server?.emitToRoom(sessionId, "build:question_asked", {
              toolCallId,
              question,
              options,
              timeoutMs: DB_GATE_TIMEOUT_MS,
              sessionId,
            });
            setTimeout(() => done(null), DB_GATE_TIMEOUT_MS);
          } catch {
            // Nobody is listening, so nothing can be asked. Build as before.
            done(null);
          }
        });

        if (answer === null) {
          // Timed out or nobody was listening. Said out loud: a build that
          // quietly decided to skip the database is the silence this whole
          // thread exists to remove.
          server?.thinking(sessionId, {
            sessionId,
            text:
              "No answer on the database yet, so I am building this without one — " +
              "the app will keep its data in the browser. Connect a database and ask " +
              "me again, and I will move it onto real tables.",
          });
        }
        const intent = interpretDatabaseAnswer(answer);
        if (intent === "connect") {
          userSupa = await getUserSupabasePreviewCreds(userId).catch(() => null);
        }
        console.log(
          `[build] db gate project=${projectId} intent=${intent} connected=${userSupa !== null}`,
        );
        if (intent === "connect" && !userSupa) {
          server?.thinking(sessionId, {
            sessionId,
            text:
              "I could not see a connected Supabase project yet, so I am building without one. " +
              "Connect it and ask me again and I will create the tables.",
          });
        }
      }

      setProjectPreviewEnv(projectId, userSupa);
      ownSupabaseConnected = userSupa !== null;
      if (userSupa) console.log(`[build] using owner's connected Supabase for preview project=${projectId}`);
      // Warm the preview sandbox NOW, in the background, so Vite is already
      // running by the time the AI finishes generating.
      prewarmSandbox(projectId, fullstackFramework, (line) =>
        server?.emitToRoom(sessionId, "build:preview_log", { sessionId, line }),
      );
    }

    // Agentic build: hand the model the sandbox and let it verify its own work
    // instead of emitting one shot of code for the pipeline below to inspect.
    //
    // Edits included. They were held back while the model had no way to see an
    // existing project; with list_files and read_file it does, and edits are
    // where this helps most — the pipeline picks the files to show the model
    // with a regex over the prompt (selectFollowUpFiles), which is a guess, and
    // a wrong guess means editing a file the model never saw. Now it looks.
    // File preservation is unaffected: preserveExistingFiles copies the whole
    // previous project into the new outputDir before anything is written, so
    // files the model doesn't touch survive exactly as they were.
    //
    // Deliberately NOT restricted by provider. Running the pipeline for one tier
    // and the agentic loop for another would mean a project built on the free
    // plan behaves differently after the user upgrades — two products in one
    // app, and a follow-up edit that doesn't work the way the original build
    // did. Both gateways speak tool calling (modal-gateway translates the
    // Anthropic tool shape to and from OpenAI's), so the tier difference stays
    // where it belongs: which model runs, not which architecture.
    //
    // Cost is bounded the same way on both: the in-loop costGuard is the real
    // limit and AGENTIC_MAX_TURNS is the backstop.
    const agenticBuild = config.AGENTIC_BUILD_ENABLED;
    if (agenticBuild) {
      console.log(`[build] agentic mode: model drives write/verify/repair for session=${sessionId}`);
      // All three agentic tools need a live sandbox, and a frontend-only build
      // wouldn't otherwise warm one until after generation. Idempotent — a
      // no-op when the fullstack branch above already started it.
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
                  "Do NOT generate next.config.ts…37241 tokens truncated…st, and nothing
    // failed. This compares the user's words against the delivered files, and
    // keeps `unverified` apart from `fail` — nothing else in the build can tell
    // the difference between "checked and fine" and "never checked".
    const extracted = await criteriaPromise;
    let completionAudit: CompletionAudit | null = null;
    if (extracted.criteria.length > 0) {
      // A gate verdict is only evidence about the code that existed when it
      // ran, so a stale one is handed over labelled rather than quietly
      // counted — see staleCheckPage in BuildOutcome.
      const gateText = (
        verdict: string,
        staleWrites: number,
      ): string => (staleWrites > 0 ? `${verdict} (STALE — ${staleWrites} write(s) landed after it)` : verdict);

      if (cumulativeCostUsd >= MAX_BUILD_COST_USD) {
        // Honest rather than optimistic: the budget stopped the audit, so
        // nothing is proven. Recording a clean sheet here would hide exactly
        // the builds most likely to be incomplete.
        completionAudit = unverifiedAudit(
          extracted.criteria,
          "the build reached its cost ceiling before the audit could run",
        );
      } else {
        completionAudit = await auditCompletion({
          dispatcher,
          criteria: extracted.criteria,
          files: allFiles,
          gates: {
            checkPage: gateText(result.gateResults.checkPage ?? "never", result.gateResults.writesAfterCheckPage ?? 0),
            checkTypes: gateText(result.gateResults.checkTypes ?? "never", result.gateResults.writesAfterCheckTypes ?? 0),
            checkTests: gateText(result.gateResults.checkTests ?? "never", result.gateResults.writesAfterCheckTests ?? 0),
          },
          sessionId, userId, projectId, provider,
        });
      }

      // Carried onto the stored audit so the record cannot read as full
      // coverage when the extraction cap dropped requirements before it ran.
      if (extracted.dropped && extracted.dropped > 0) {
        completionAudit = { ...completionAudit, criteriaDropped: extracted.dropped };
      }

      // A requirement cited to a file that fakes it is not proven. Re-measured
      // over the FINAL file set rather than reusing the earlier result: the
      // removal dispatch above runs between the two, so a stand-in it took out
      // must not go on discounting a verdict that is now honestly proven.
      const fakedNow = fakePersistence(allFiles).map((f) => f.path);
      if (fakedNow.length > 0) {
        const before = completionAudit.proven;
        completionAudit = discountFakedEvidence(completionAudit, fakedNow);
        if (completionAudit.proven !== before) {
          console.log(
            `[build] audit discounted session=${sessionId} proven ${before} → ` +
            `${completionAudit.proven} (evidence in faked file(s))`,
          );
        }
      }

      cumulativeCostUsd += extracted.costUsd + completionAudit.costUsd;
      console.log(
        `[build] audit session=${sessionId} proven=${completionAudit.proven} ` +
        `unverified=${completionAudit.unverified} contradicted=${completionAudit.contradicted} ` +
        `of=${completionAudit.criteria.length}`,
      );

      // Said in the chat again, in the USER's language this time.
      //
      // It was pulled on 2026-10-10 because what it said was written for a
      // maintainer — it named files, stores and exported functions, and a person
      // who asked for a habit tracker is not served by reading that their build
      // has a `deleteHabit` action with no caller. That was the right call about
      // the WORDING and the wrong one about the audience: this check is the only
      // thing in the product that compares what the person actually asked for
      // against what was delivered, and hiding it left them with the same
      // build-loop-and-hope every competitor ships.
      //
      // formatAuditForUser now shows only the criterion text — which is the
      // user's own words, lifted from their prompt by the acceptance pass — and
      // never the auditor's note or its file citations. Those stay in
      // build_outcome.completionAudit for the eval and for triage.
      // Chat lines only — no `build:completion_audit` event. The frontend's
      // handler and its card were removed with the old wording, and emitting to
      // nobody is the dead-path habit this repo keeps finding in its own code.
      // The thinking stream is where the user is already looking, and it needs
      // no frontend change to land.
      for (const line of formatAuditForUser(completionAudit)) {
        server?.thinking(sessionId, { text: line, sessionId });
      }
    }

    // ── The audit found gaps. Go and fix them ───────────────────────────────
    // THE HALF THAT WAS MISSING. The audit turns the person's own words into
    // requirements and marks each one proven / contradicted / unverified — and
    // nothing acted on it. Measured 2026-10-19: a follow-up build ended 0
    // proven, 2 unverified, and completed anyway. Seeing a gap and shipping it
    // is barely better than not seeing it; the person still gets an app that
    // does not do what they asked, now with a note attached.
    //
    // Strict on purpose. One attempt, only with a live sandbox, only when the
    // list is short enough that one dispatch could plausibly close it, and the
    // result is kept only if it survives a type check and does not un-prove
    // something that was already proven.
    const repairPlan = hasSandbox(projectId) ? planAuditRepair(completionAudit) : null;
    if (completionAudit && !repairPlan) {
      console.log(`[build] audit repair session=${sessionId} skipped=${whyNoRepair(completionAudit)}`);
    }
    if (repairPlan && completionAudit && cumulativeCostUsd < MAX_BUILD_COST_USD) {
      const before = completionAudit;
      server?.thinking(sessionId, {
        sessionId,
        text: `${repairPlan.items.length} thing(s) you asked for aren't actually there yet — going back to finish them…`,
      });

      // The two things the judgement needs, taken before anything changes.
      const typesBefore = await runTypeCheck(projectId).catch(() => null);
      const snapshot = { ...allFiles };
      let outcome: RepairOutcome = "no-files";
      let repairCost = 0;

      try {
        const fix = await dispatcher.dispatch({
          agentType: "fix",
          usageCategory: "build",
          provider,
          task: {
            description: `${auditRepairInstruction(repairPlan)}\n\nThe project as it stands:\n\n${formatFilesForRepair(allFiles)}`,
            outputFormat: "code",
          },
          sessionId,
          userId,
          projectId,
          enableTools: false,
          costGuard: { cumulativeUsd: cumulativeCostUsd, maxUsd: MAX_BUILD_COST_USD },
        });
        repairCost += fix.costUsd ?? 0;
        cumulativeCostUsd += fix.costUsd ?? 0;

        // New files are allowed: a requirement that is missing usually needs
        // one. Same rule as the broken-import loop, opposite of the cut.
        const written: string[] = [];
        for (const file of parseFilesFromContent(fix.content ?? "")) {
          // A template-owned path is refused here exactly as everywhere else —
          // the sandbox owns vite.config.ts and writing it breaks the preview.
          if (file.code.trim().length > 0 && !isTemplateOwnedFile(file.path)) {
            allFiles[file.path] = file.code;
            written.push(file.path);
          }
        }

        if (written.length > 0) {
          await writeFilesToSandbox(projectId, allFiles).catch(() => undefined);
          recorder.record({ type: "repair/applied", kind: "completion-audit" });
          recorder.record({ type: "files/written", paths: written, added: 0, removed: 0 });

          const typesAfter = await runTypeCheck(projectId).catch(() => null);

          // Re-audit with the SAME criteria over the new files. This is the
          // only way to know whether the repair worked, and it is paid for
          // only when a repair actually landed.
          const after = await auditCompletion({
            dispatcher,
            criteria: before.criteria,
            files: allFiles,
            gates: {
              // Both of these are the model's own verdicts from before the
              // repair, so they are labelled STALE rather than quoted as if
              // they described the files the re-audit is reading. The types
              // verdict is the only one that was actually re-run.
              checkPage: `${result.gateResults.checkPage ?? "never"} (STALE — a repair landed after it)`,
              checkTypes: typesAfter === null || typesAfter.unavailable
                ? "unavailable"
                : typesAfter.ok ? "pass" : "fail",
              checkTests: `${result.gateResults.checkTests ?? "never"} (STALE — a repair landed after it)`,
            },
            sessionId,
            userId,
            projectId,
            provider,
          });
          repairCost += after.costUsd;
          cumulativeCostUsd += after.costUsd;

          outcome = judgeRepair({
            typesWereGreen: typesBefore?.ok === true,
            typesAreGreen: typesAfter ? typesAfter.ok : null,
            provenBefore: before.proven,
            provenAfter: after.proven,
          });

          if (outcome === "kept") {
            // The record now describes the repaired app, which is the one the
            // user gets. Keeping the old audit would understate a fix that
            // worked and overstate one that did not.
            completionAudit = after;
            if (typesAfter && !typesAfter.unavailable) {
              recorder.record({ type: "verification/result", gate: "types", status: typesAfter.ok ? "pass" : "fail" });
            }
          } else {
            Object.assign(allFiles, snapshot);
            for (const path of written) if (!(path in snapshot)) delete allFiles[path];
            await writeFilesToSandbox(projectId, allFiles).catch(() => undefined);
            recorder.record({ type: "repair/applied", kind: "completion-audit-reverted" });
            recorder.record({ type: "files/written", paths: written, added: 0, removed: 0 });
          }
        }
      } catch (err) {
        logger.warn({ sessionId, projectId, err }, "Completion-audit repair dispatch failed");
        outcome = "no-files";
      }

      const fixed = Math.max(0, completionAudit.proven - before.proven);
      const remaining = completionAudit.unverified + completionAudit.contradicted;
      auditRepair = { outcome, attempted: repairPlan.items.length, fixed, remaining, costUsd: repairCost };
      console.log(
        `[build] audit repair session=${sessionId} outcome=${outcome} attempted=${repairPlan.items.length} ` +
        `fixed=${fixed} remaining=${remaining} cost=$${repairCost.toFixed(4)}`,
      );
      const line = describeRepair(outcome, fixed, remaining);
      if (line) server?.thinking(sessionId, { sessionId, text: line });

      // The repair wrote files AFTER every gate, including a revert — which
      // restores the old bytes but leaves the event stream saying a write
      // landed. Either way the gates have been outrun, so re-run whatever the
      // projection now calls stale. Without this, a repair that compiles but
      // renders a white screen would ship behind a page verdict obtained
      // before it existed.
      await revalidateStaleGates();
    }

    // ── Dead code in what is actually being delivered ───────────────────────
    // Measured here rather than only when the model called find_dead_code, and
    // for the same reason build_outcome exists at all: a number nobody records
    // cannot answer a question later. It costs nothing — no model call, no
    // sandbox — and it runs over the final set, after every repair loop, so it
    // describes what the user gets. Advisory only: the analysis is textual, so
    // it reports and never blocks a build.
    // Re-measured over the final set rather than reusing the loop's last count,
    // for the reason this file keeps relearning: the repair loops between there
    // and here mutate `allFiles`, so a number carried forward describes code the
    // build no longer has. `repaired` is the one figure that has to be carried,
    // since it is a difference across the loop and cannot be recovered from the
    // end state.
    const wiringFindings = findWiringGaps(allFiles);
    const wiringTally = tallyWiringGaps(wiringFindings);

    // The same question wiring asks, one layer down: the app RENDERS, its
    // controls respond — and is there a database behind any of it?
    //
    // Measured 2026-10-17: the shared preview project holds no app tables at
    // all, because `schema.sql` is only ever applied to a Supabase the user
    // connected themselves. Without one, every read fails and the generated
    // error handling turns the failure into an empty list, so a hollow app
    // passes every gate looking finished. This is the only check that can tell
    // those apart, and like wiring it reports and never blocks.
    const dataLayerFindings = findDataLayerGaps(allFiles, {
      configured:
        ownSupabaseConnected ||
        Boolean(config.PREVIEW_SUPABASE_URL && config.PREVIEW_SUPABASE_ANON_KEY) ||
        Boolean(config.PREVIEW_MONGODB_URI),
      schemaApplied: ownSupabaseConnected,
    });
    for (const line of formatDataLayerForUser(dataLayerFindings)) {
      server?.thinking(sessionId, { text: line, sessionId });
    }
    if (dataLayerFindings.length > 0) {
      console.log(
        `[build] data layer session=${sessionId} findings=${dataLayerFindings.length} ` +
        `kinds=[${[...new Set(dataLayerFindings.map((f) => f.kind))].join(",")}] ` +
        `ownSupabase=${ownSupabaseConnected}`,
      );
    }

    // Said in the chat, in the USER's language.
    //
    // The repair loop declines two of the seven kinds on purpose — an endpoint
    // nothing calls and a "coming soon" label both need a product decision, so
    // they are left for the user's next prompt. Left unsaid, that decision is
    // indistinguishable from the check not working: the finding went into
    // build_outcome and the one person who could act on it never heard about
    // it. Chat lines only, no new event — the same choice the audit lines
    // landed on, for the same reason. The thinking stream is where the user is
    // already looking and it needs no frontend change.
    for (const line of formatWiringForUser(wiringFindings, wiringRepaired)) {
      server?.thinking(sessionId, { text: line, sessionId });
    }

    if (wiringTally.total > 0 || wiringRepaired > 0) {
      console.log(
        `[build] wiring final session=${sessionId} total=${wiringTally.total} ` +
        `repaired=${wiringRepaired} deadHandlers=${wiringTally.deadHandlers} ` +
        `bareButtons=${wiringTally.bareButtons} deadLinks=${wiringTally.deadLinks} ` +
        `missingEndpoints=${wiringTally.missingEndpoints}`,
      );
    }

    // ── Tests that pass while proving nothing ─────────────────────────────────
    // Free, deterministic, over the delivered files, for the same reason the
    // wiring scan above runs here: no model call, no sandbox, and it describes
    // what the user actually gets rather than some mid-build state.
    //
    // This is the check that guards the most misleading field in the record.
    // `checkTests: "pass"` on its own cannot tell a real green run from four
    // tests with no assertion in them, and a build handed that verdict has
    // proof of correctness it never earned. Advisory only — it reports and
    // never blocks, because a thin test is a reason to look, not a broken app.
    const hollowFindings = findHollowTests(allFiles);
    const hollowTally = tallyHollowTests(hollowFindings);

    // In the user's language, chat lines only — the same choice the wiring and
    // audit lines landed on, and for the same reason: the thinking stream is
    // where the user is already looking and it needs no frontend change. The
    // formatter emits counts and fixed prose only; no path or source text from
    // a finding crosses into the chat.
    for (const line of formatHollowTestsForUser(hollowFindings)) {
      server?.thinking(sessionId, { text: line, sessionId });
    }

    if (hollowTally.total > 0) {
      console.log(
        `[build] hollow tests session=${sessionId} total=${hollowTally.total} ` +
        `noAssertions=${hollowTally.noAssertions} literalAssertions=${hollowTally.literalAssertions} ` +
        `importsNothing=${hollowTally.importsNothing} skipped=${hollowTally.skippedTests} ` +
        `empty=${hollowTally.emptyTests} checkTests=${result.gateResults.checkTests ?? "never"}`,
      );
    }

    // ── Is the shape of this codebase going wrong? (E5) ─────────────────────
    // Four structural signals over the delivered files: import cycles, a
    // component reaching into the server or the database, a file that has grown
    // past being readable, and function bodies that are character-for-character
    // identical.
    //
    // ADVISORY, and that is a decision rather than an omission. Every other
    // repair loop in this file fixes something a USER would hit — a button that
    // does nothing, an import that points at nothing. These four are about how
    // the code reads, and a repair dispatch that rewrites working code to
    // satisfy a style rule is churn: it costs money, invalidates every gate
    // above it, and risks breaking an app that worked. `duplicate-logic` and
    // `file-too-large` are the clearest cases — "extract this into src/lib" is
    // a judgement about a codebase nobody has to maintain yet.
    //
    // Every finding carries its own remediation in `detail`, so the model (on a
    // follow-up) and the record both get the fix and not just the complaint.
    const architectureFindings = findArchitectureGaps(allFiles);
    const architectureTally = {
      circularImports: architectureFindings.filter((f) => f.kind === "circular-import").length,
      layerViolations: architectureFindings.filter((f) => f.kind === "layer-violation").length,
      filesTooLarge: architectureFindings.filter((f) => f.kind === "file-too-large").length,
      duplicateLogic: architectureFindings.filter((f) => f.kind === "duplicate-logic").length,
      total: architectureFindings.length,
    };
    // Logged on every build, including the clean one: "the gate ran and found
    // nothing" and "the gate never ran" are different facts, and only the first
    // is evidence. Same reason `interactions.ran` exists.
    console.log(
      `[build] architecture session=${sessionId} total=${architectureTally.total} ` +
      `cycles=${architectureTally.circularImports} layer=${architectureTally.layerViolations} ` +
      `large=${architectureTally.filesTooLarge} duplicate=${architectureTally.duplicateLogic} ` +
      `files=${Object.keys(allFiles).length}`,
    );
    if (architectureFindings.length > 0) {
      // The remediation goes with the finding — this is the formatter that
      // carries `detail`, so nothing reaches the record or a later round as a
      // bare complaint.
      logger.info(
        {
          sessionId,
          projectId,
          kinds: [...new Set(architectureFindings.map((f) => f.kind as ArchitectureKind))],
          findings: formatArchitectureGaps(architectureFindings),
        },
        "[build] architecture findings — advisory, each carries its fix",
      );
    }

    const deadFindings = findDeadCode(allFiles);
    const deadTally = tallyDeadCode(deadFindings);
    if (deadFindings.length > 0) {
      console.log(
        `[build] dead code session=${sessionId} unusedImports=${deadTally.unusedImports} ` +
        `unreferencedExports=${deadTally.unreferencedExports} neverRendered=${deadTally.neverRendered} ` +
        `modelAsked=${result.deadCode.called}`,
      );
    }

    // Close out the evidence record: file count from what was actually written
    // to disk (the fence-parsing path writes files the dispatch never reported),
    // and cost across every dispatch this build made, not just the first.
    // Taken here, not before the audit: the acceptance-extraction and audit
    // dispatches add themselves to cumulativeCostUsd above, and computing this
    // first meant the column billing.ts sums for usage reporting excluded both
    // while buildOutcome.costUsd included them — one build with two figures
    // that disagreed by roughly the audit's own $0.06. The user is charged for
    // those dispatches either way; deductUsage runs per-dispatch in
    // dispatcher.ts. This only makes the record match what was spent.
    const usageUsd = cumulativeCostUsd * config.USAGE_MARGIN_MULTIPLIER;

    // ── What a fullstack request ACTUALLY got ───────────────────────────────
    // Measured 2026-10-18 on a real build: the closing message called a
    // "complete E-commerce Store" finished while the same build also said
    // "Login/Signup (mock authentication)" and "TanStack Query ready". Both
    // sentences came from the model. One of them was true.
    //
    // So the final status is assembled from evidence that already exists —
    // the build's own classification, the files it wrote, whether a database
    // was connected, what the data-layer scan found, and the fake-persistence
    // detector — rather than from another keyword heuristic over the model's
    // prose. Each part is proven or it is not, and the message below says which.
    // MEASURED 2026-10-19, the launch-proof build. The prompt asked for people
    // to "sign in" and for claims that "persist in the database so they survive
    // a reload". The classifier called it a frontend build, zero backend files
    // were written, the app kept everything in localStorage with four hardcoded
    // users — and the closing message read "now complete and fully functional".
    //
    // This block did not fire, because it only triggered on the build having a
    // backend. That is the wrong test: the case that most needs an honest
    // sentence is exactly the one where the request implied a server and the
    // build did not produce one. So the trigger is what was ASKED as well as
    // what was built, using the auth signal that already exists rather than a
    // new keyword list.
    //
    // (A follow-up edit is also never classified "fullstack" — that flag is
    // new-builds-only by design — so an edit to an app that HAS a backend has
    // always needed the second clause.)
    const fullstackRequested = isFullstackBuild || backendFileCount > 0 || needsAuth(prompt);
    const fakeFiles = fullstackRequested ? fakePersistence(allFiles).map((f) => f.path) : [];
    const declared = fullstackRequested ? declaredTables(allFiles) : new Set<string>();
    const queried = fullstackRequested ? queriedTables(allFiles) : [];
    const authWanted = needsAuth(prompt);
    // A real auth call, not a mocked one: the shapes the prompt actually tells
    // the model to use, and never counted from a file the fake detector flagged.
    const authReal = Object.entries(allFiles).some(
      ([path, code]) =>
        !fakeFiles.includes(path) &&
        /supabase\.auth\.|signInWithPassword|signInWithOAuth|auth\.getUser\(|getSession\(/.test(code),
    );
    // An observation of the DELIVERED CODE, not of the prompt: this app's data
    // lives in one browser. Said plainly because a person reading "complete and
    // fully functional" has no way to know their data is not on a server, will
    // not be on their phone, and is gone if they clear their browser.
    const writesBrowserStorage = Object.entries(allFiles).some(
      ([path, code]) => /\.(tsx?|jsx?)$/.test(path) && /\b(localStorage|sessionStorage)\s*\.\s*setItem\b/.test(code),
    );
    const fullstackEvidence = fullstackRequested
      ? {
          requested: isFullstackBuild,
          browserOnlyPersistence: writesBrowserStorage && backendFileCount === 0 && !ownSupabaseConnected,
          backendFiles: backendFileCount,
          // `ownSupabaseConnected` is decided at the TOP of the build, and the
          // database card can be answered while the build is still running —
          // which is exactly what happened on 2026-10-23 (session c777a195):
          // the schema applied to a real project and created a real `tasks`
          // table, while this block still said false, so the closing message
          // was ready to tell the user "Database: not connected, so nothing is
          // saved on a server" about a database it had just written to.
          //
          // A schema that applied is proof a database was connected, whatever
          // the flag captured minutes earlier.
          databaseConnected: ownSupabaseConnected || schemaApply?.ok === true,
          tablesDeclared: declared.size,
          tablesQueried: new Set(queried.map((q) => q.table)).size,
          fakePersistenceFiles: fakeFiles.length,
          authRequested: authWanted,
          authReal: authWanted ? authReal : false,
          ...(schemaApply ? { schemaApply } : {}),
        }
      : null;
    if (fullstackEvidence) {
      console.log(
        `[build] fullstack evidence session=${sessionId} backendFiles=${fullstackEvidence.backendFiles} ` +
        `db=${fullstackEvidence.databaseConnected} declared=${fullstackEvidence.tablesDeclared} ` +
        `queried=${fullstackEvidence.tablesQueried} fake=${fullstackEvidence.fakePersistenceFiles} ` +
        `authWanted=${fullstackEvidence.authRequested} authReal=${fullstackEvidence.authReal} ` +
        `browserOnly=${fullstackEvidence.browserOnlyPersistence}`,
      );
    }

    // Shaped once here so the record's own narrowing is unambiguous.
    const snap: StorageSnapshot | null = previewEvidence.storage;
    const snapSource = previewEvidence.storageSource;
    const storageEvidence =
      snap && snapSource
        ? {
            ran: snap.ran,
            source: snapSource,
            localKeys: snap.local.length,
            sessionKeys: snap.session.length,
            indexedDbs: snap.indexedDb.length,
          }
        : null;

    // ── The outcome, folded from the event stream (C3) ──────────────────────
    // The CORE of this record is now derived rather than remembered. Rounds,
    // tool calls, gate verdicts and — the reason this exists — how many writes
    // landed after each verdict come from folding the ordered events, so
    // staleness is computed from what happened instead of being tracked by a
    // mutable object with one slot per gate.
    //
    // THE SECOND HALF IS NOT EVENT-DERIVED AND IS NOT PRESENTED AS IF IT WERE.
    // deadCode, wiring, hollowTests, architecture, interactions, storage,
    // review and the completion audit are single observations of the FINAL
    // state, measured once, just now, over the files that are shipping. Turning
    // each into an "evidence event" would have made the projection look purer
    // while adding a layer that invents an ordering nothing actually has.
    // They are attached, separately and deliberately, below the fold.
    //
    // `review` and the plan flags still come from outcomeDraft: the review
    // dispatches run inside the tool loop and the plan ran before it, and
    // neither is reconstructible from the events emitted today.
    recorder.record({
      type: "build/end",
      turnsExhausted: result.turnsExhausted,
      filesWritten: writtenPaths.length,
      costUsd: cumulativeCostUsd,
      durationMs: Date.now() - buildStartedMs,
      ...(result.churn === undefined ? {} : { churn: result.churn }),
    });
    await recorder.flush();

    const projected = projectOutcome(recorder.events());
    const outcome: BuildOutcome = {
      // Fields the events cannot carry, kept from the draft.
      ...outcomeDraft,
      // Everything the fold owns, over the top of it.
      ...projected,
      // Final-state observations. Not event-derived; see above.
      deadCode: deadTally,
      wiring: { ...wiringTally, repaired: wiringRepaired, costUsd: wiringCostUsd },
      hollowTests: previewEvidence.hollow ?? hollowTally,
      architecture: architectureTally,
      ...(previewEvidence.interactions ? { interactions: previewEvidence.interactions } : {}),
      ...(storageEvidence ? { storage: storageEvidence } : {}),
      ...(completionAudit
        ? { completionAudit, unverifiedCount: completionAudit.unverified }
        : {}),
      ...(fullstackEvidence ? { fullstack: fullstackEvidence } : {}),
      ...(classification
        ? { classification: { buildType: classification.buildType, source: classification.source, reason: classification.reason } }
        : {}),
      ...(result.pseudoToolCalls.length > 0 ? { pseudoToolCalls: result.pseudoToolCalls } : {}),
      ...(stillStale.length > 0 ? { unverifiedGates: stillStale } : {}),
      ...(recorder.lostCount() > 0 ? { eventsLost: recorder.lostCount() } : {}),
      ...(auditRepair ? { auditRepair } : {}),
    };

    // The projection refuses to invent what it was not told, so a stream that
    // lost its rows would throw rather than report zeroes as measurements —
    // which is why the terminal event is flushed before this point and why a
    // short stream is recorded as `eventsLost` rather than smoothed over.
    console.log(
      `[build] outcome session=${sessionId} source=projection events=${recorder.events().length} ` +
      `rounds=${outcome.rounds} tools=${Object.keys(outcome.toolCalls).length} ` +
      `page=${outcome.checkPage}/${outcome.staleCheckPage ?? 0} ` +
      `types=${outcome.checkTypes}/${outcome.staleCheckTypes ?? 0} ` +
      `tests=${outcome.checkTests}/${outcome.staleCheckTests ?? 0} lost=${recorder.lostCount()}`,
    );

    // A build whose page does not render, or whose code does not compile, is
    // not a success — and saying so in the row is the difference between a
    // history the owner can trust and one that agrees with whatever the model
    // claimed. Measured 2026-10-23 (session df827368): checkPage=fail,
    // checkTypes=fail, both fresh, row written status="success".
    //
    // "completed" rather than "failed": the build DID produce an app, and the
    // frontend already maps completed and success to the same "complete" state
    // (extractBuildStatus), so the person still gets their preview. What
    // changes is that the record stops claiming the work is good.
    const gatesFailed = outcome.checkPage === "fail" || outcome.checkTypes === "fail";
    if (gatesFailed) {
      console.log(
        `[build] honest-status session=${sessionId} status=completed ` +
        `page=${outcome.checkPage} types=${outcome.checkTypes}`,
      );
    }

    await db
      .update(buildSessions)
      .set({
        status: gatesFailed ? "completed" : "success",
        phase: 2,
        outputDir,
        creditsUsed,
        usageUsd,
        buildOutcome: outcome,
        completedAt: new Date(),
      })
      .where(eq(buildSessions.id, sessionId));

    await db
      .update(projects)
      .set({ status: "live" })
      .where(eq(projects.id, projectId));
    outcomeRecorded = true;

    // ── Emit complete — the last word, and only now ─────────────────────────
    // Everything above has finished: generation, the deterministic audits, every
    // repair loop, the freshness re-runs over what those loops changed, the
    // final observations and the completion audit. This is the first point at
    // which "it is done" is true.
    //
    // The model's own summary is kept — it describes the app better than
    // anything generated from a file list — but it is no longer the only thing
    // said. What follows it is assembled from evidence, because the model's
    // prose is where "complete E-commerce Store" and "mock authentication"
    // appeared in the same build.
    const closingLines: string[] = [];

    // ── What the checks found, said FIRST and in plain words ────────────────
    // MEASURED 2026-10-23 on a real build (session df827368, "Build me a habit
    // tracker"): checkPage=fail, checkTypes=fail, BOTH FRESH (stale=0, so they
    // were re-run at the end and still failed) — and the user was told "Your
    // HabitFlow habit tracker is complete!". Nothing anywhere in this closing
    // block mentioned either failure, and the row was written status=success.
    //
    // The model's own summary is the last thing the person reads and it is
    // written by the thing being graded, so it cannot be the only account of
    // whether the app works. The gates have to speak for themselves, before
    // anything else, in words that describe what the person will SEE rather
    // than the name of the check that failed.
    //
    // "fail" only — "never" and "unavailable" are not failures, and claiming
    // they are would make every build that could not run a gate look broken.
    const pageFailed = outcome.checkPage === "fail";
    const typesFailed = outcome.checkTypes === "fail";
    if (pageFailed || typesFailed) {
      closingLines.push("Before anything else — this build is NOT finished:");
      if (pageFailed) {
        closingLines.push(
          "• The app does not open. The page throws an error when it loads, so whatever the " +
            "preview is showing is not this app working.",
        );
      }
      if (typesFailed) {
        closingLines.push(
          "• The code does not compile — there are type errors. Even if the preview shows " +
            "something, this will not build for production in its current state.",
        );
      }
      closingLines.push("Send me a follow-up message and I will fix this before anything else.");
    }

    if (fullstackEvidence) {
      const fs = fullstackEvidence;
      const real =
        fs.backendFiles > 0 &&
        fs.databaseConnected &&
        fs.tablesQueried > 0 &&
        fs.fakePersistenceFiles === 0 &&
        // A connected database with no tables in it is not a working one.
        fs.schemaApply?.ok !== false;
      closingLines.push(
        real
          ? "This has a real backend: server code, a connected database, and queries against it."
          : "What is real, and what is not, in this build:",
      );
      if (!real) {
        closingLines.push(
          fs.backendFiles > 0
            ? `• Backend code: written (${fs.backendFiles} file(s)).`
            : "• Backend: none was written — this is a frontend-only app.",
        );
        if (fs.browserOnlyPersistence) {
          closingLines.push(
            "• Your data is saved in this browser only. It will not be there on another device " +
              "or for another person, and clearing the browser clears it.",
          );
        }
        closingLines.push(
          fs.databaseConnected
            ? "• Database: your own Supabase is connected."
            : "• Database: not connected, so nothing is saved on a server. Connect one and I will wire it up.",
        );
        // The tables are the difference between a connected database and a
        // working one. A failure here used to reach a log line and nothing
        // else, while the closing message said the build was complete.
        if (fs.schemaApply?.ran === false && fs.schemaApply.error === "no Supabase connected") {
          closingLines.push(
            "• Tables: I wrote the schema but there was no database to create it in, so every save will fail until you connect one.",
          );
        } else if (fs.schemaApply?.ran && !fs.schemaApply.ok) {
          closingLines.push(
            "• Tables: I could NOT create them in your Supabase, so saving will not work yet. " +
              `The reason it gave: ${String(fs.schemaApply.error ?? "unknown").slice(0, 200)}`,
          );
        } else if (fs.schemaApply?.ok) {
          closingLines.push("• Tables: created in your Supabase, so the app has somewhere real to save.");
        }
        if (fs.tablesDeclared > 0 || fs.tablesQueried > 0) {
          closingLines.push(
            `• Tables: ${fs.tablesDeclared} declared, ${fs.tablesQueried} actually queried by the app.`,
          );
        }
        if (fs.fakePersistenceFiles > 0) {
          closingLines.push(
            `• ${fs.fakePersistenceFiles} file(s) fall back to demo data when the backend is missing — those screens are not reading real data.`,
          );
        }
        if (fs.authRequested) {
          closingLines.push(
            fs.authReal
              ? "• Sign-in: real — it calls the auth service."
              : "• Sign-in: not real yet. The screens are there; nothing checks a password.",
          );
        }
      }
    }
    const emailConfirmationGuidance = formatPreviewEmailConfirmationGuidance(
      allFiles,
      fullstackEvidence?.databaseConnected === true,
    );
    if (emailConfirmationGuidance) closingLines.push(emailConfirmationGuidance);
    // A table the app queried and never created is the difference between an
    // app that saves and one that looks like it saves, so the user is told it
    // was fixed rather than left to infer it from an app that now works.
    if (schemaTablesAdded > 0) {
      closingLines.push(
        schemaTablesAdded === 1
          ? "• The app was saving to a table that did not exist — I added it to the schema, with its access rules."
          : `• The app was saving to ${schemaTablesAdded} tables that did not exist — I added them to the schema, with their access rules.`,
      );
    }
    // What the build did about what the audit found. Said here as well as in
    // the live stream, because this block is what the user can scroll back to.
    if (auditRepair) closingLines.push(repairStatusLine(auditRepair));
    if (stillStale.length > 0) {
      closingLines.push(
        `• Not re-checked after the last fixes: ${stillStale.join(", ")}. The preview had already stopped, so I could not run those again — treat them as unverified.`,
      );
    }
    if (postBuildOverran) {
      closingLines.push(
        "• The preview checks ran out of time, so some of the usual verification is missing from this build.",
      );
    }

    const finalSummary = [buildSummary, ...closingLines].filter(Boolean).join("\n");

    server?.buildComplete(sessionId, {
      sessionId,
      files: frontendFiles,       // Sandpack-safe: no Node.js imports
      backendFiles: allFiles,
      backendFileCount,           // >0 signals fullstack build to the client
      previewUrl: null,
      totalFiles: Object.keys(allFiles).length,
      ...(finalSummary ? { summary: finalSummary } : {}),
    });

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

    // The stream gets its terminal event on this path too. Without one the
    // projection refuses to produce an outcome at all — deliberately, so a
    // half-recorded build can never be read as a measured one — and a failed
    // build is the case the evidence is most wanted for.
    recorder.record({
      type: "build/failed",
      reason: errorMsg,
      turnsExhausted: false,
      filesWritten: 0,
      costUsd: 0,
      durationMs: Date.now() - buildStartedMs,
    });
    await recorder.flush();

    await db
      .update(buildSessions)
      .set({
        status: "failed",
        error: errorMsg,
        // Null when the failure happened before the generation dispatch
        // returned — there is genuinely nothing to record in that case.
        ...(outcomeDraft
          ? { buildOutcome: { ...outcomeDraft, durationMs: Date.now() - buildStartedMs } }
          : {}),
        completedAt: new Date(),
      })
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
  } finally {
    runningSessions.delete(sessionId);
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

  // Pre-launch waitlist. The frontend already replaces the product with a
  // thank-you page, but that's a UI decision and this endpoint is the one that
  // spends real money on every call — Anthropic tokens and an E2B sandbox. A
  // gate that only exists in the client is not a gate. Admins stay exempt so
  // the product can still be tested while the waitlist is up.
  if (config.WAITLIST_MODE && !isAdmin(authUser.email)) {
    throw new AppError(
      403,
      "Lampcode is not open yet — you're on the waitlist and we'll email you when your access is ready.",
      "WAITLIST_ACTIVE",
    );
  }

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

  // ── Budget check (admins bypass entirely) ─────────────────────────────────
  // No flat pre-charge anymore — real usage is deducted per-dispatch as it's
  // actually incurred (see dispatcher.ts's deductUsage hook). This just
  // refuses to START a build with zero balance left.
  const adminBypass = isAdmin(authUser.email);
  if (adminBypass) {
    console.log("[CREDITS] Admin bypass for:", authUser.email);
  } else {
    await assertHasBudget(authUser.id);
  }
  console.log(`[FAST t+${Date.now()-t0}ms] budget ${adminBypass ? "bypassed" : "checked"}`);

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
        // No more upfront action-vs-build routing here — the main dispatch
        // inside runFastBuild() now decides for itself (via the MCP connector
        // + request_write_action tool) whether this is a build, an action on
        // a connected service, or both. See runFastBuild()'s post-dispatch
        // "zero files produced" branch for how a pure-action response is
        // handled without running the sandbox/fix-loop machinery.
        return runFastBuild(sessionId, projectId, prompt, userId, refImgFlag, agentFlag, animationFlag, memoryFlag, manifestFlag).catch((err) => {
          console.error(err);
          // Nothing to refund — whatever dispatches actually ran before this
          // failure already deducted their real usage via dispatcher.ts's
          // per-dispatch hook, and that stays charged regardless of whether
          // the overall build ultimately succeeded.
        });
      })();
    });
  } catch (err) {
    // Session creation itself failed (DB insert or project update) — no
    // dispatch could have run yet, so no usage was incurred either.
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
    usageUsd: session.usageUsd,
    outputDir: session.outputDir,
    previewUrl: session.previewUrl,
    // What the build actually did — rounds, tool calls, and whether the model's
    // own gates passed. Null on every session built before this was recorded,
    // and on the pipeline path, which has no agent gates to report. The eval
    // harness (scripts/eval) scores builds from this.
    buildOutcome: session.buildOutcome,
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
  let files = await walkDirectory(workspaceBase, workspaceBase);

  // ── Disk miss → fall back to storage ────────────────────────────────────
  // WORKSPACE_BASE is local disk, and Railway's disk does not survive a
  // deploy. Without this the endpoint answered `groups: {}` for any project
  // built before the last deploy — measured 2026-10-10, two sessions that
  // returned 19 and 20 files in the morning returned 0 in the afternoon with
  // their files sitting untouched in Supabase Storage. Nothing was lost and
  // nothing said so; the file list simply went empty.
  //
  // The build path already does exactly this on a disk miss
  // (`downloadProjectFiles`), so this endpoint was the one reader that did
  // not. Read-only here on purpose — the build path restores to disk because
  // later steps read from it, and a GET has no reason to write.
  //
  // Storage is keyed by PROJECT, not by session, so this returns the
  // project's current files rather than that session's. For the latest
  // session they are the same thing; for an older one it is the closest
  // honest answer available, and better than claiming there are none.
  if (files.length === 0) {
    try {
      const stored = await downloadProjectFiles(session.projectId);
      const paths = Object.keys(stored);
      if (paths.length > 0) {
        console.log(
          `[files] disk miss for session=${sessionId} — served ${paths.length} file(s) from storage`,
        );
        files = paths.map((p) => {
          const content = stored[p] ?? "";
          return {
            path: p,
            content,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            lines: content.split("\n").length,
          };
        });
      }
    } catch (err) {
      // Never fail the request over this: an empty list is what it returned
      // before, so the worst case is the behaviour that was already there.
      logger.warn({ sessionId, projectId: session.projectId, err }, "[files] storage fallback failed");
    }
  }

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
    // The frontend polls this endpoint every 3s when it has no preview URL,
    // and gives up after 120s with "no preview URL was returned". It was
    // polling an endpoint that never returned one, so that message was
    // guaranteed the moment the socket event was missed — about a sandbox
    // that was up and serving.
    previewUrl: session.previewUrl,
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
