import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc, isNotNull } from "drizzle-orm";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "fs/promises";
import { join, dirname, relative } from "path";
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
import { expandUserPrompt } from "../../agents/prompt-builder.js";
import {
  parseFilesFromContent,
  parseSurgicalEdits,
  applySurgicalEdit,
  stripEditMarkers,
  type ParsedFile,
} from "../../agents/file-parser.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";
import { deductCredits, refundCredits } from "../../build/credits.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(process.cwd(), "workspace");

const FAST_BUILD_CREDIT_COST = 20;

// ── In-memory cancel registry ─────────────────────────────────────────────────

const cancelledSessions = new Set<string>();

// ── WS helper — never throws ──────────────────────────────────────────────────

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

// ── Input schemas ─────────────────────────────────────────────────────────────

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
    // filesystem miss (container restart or first build) — fall through as new build
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

// ── Smart follow-up file selection ────────────────────────────────────────────

/**
 * For short follow-up prompts, select only the 1–2 files likely to change.
 * Also flags theme/color prompts as token-only edits so the caller can send
 * just the :root block instead of the full styles.css.
 */
function selectFollowUpFiles(
  files: Record<string, string>,
  prompt: string,
): { selected: Record<string, string>; isSmartSelection: boolean; isTokenOnlyEdit: boolean } {
  const p = prompt.toLowerCase();
  const isThemePrompt = /\b(theme|color|colour|dark|light|background|palette|gradient|border|shadow)\b/.test(p);

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

// ── Background build runner ───────────────────────────────────────────────────

export async function runFastBuild(
  sessionId: string,
  projectId: string,
  prompt: string,
  userId: string,
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
        const { selected, isSmartSelection, isTokenOnlyEdit: tokenOnly } = selectFollowUpFiles(existingFiles, prompt);
        if (isSmartSelection) {
          contextFiles = selected;
          smartSelectionUsed = true;
          isTokenOnlyEdit = tokenOnly;
          console.log(`[build] smart context: ${Object.keys(contextFiles).length}/${Object.keys(existingFiles).length} files → LLM (tokenOnlyEdit=${isTokenOnlyEdit})`);
        }
      }
    }

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
          ? buildEditPrompt(contextFiles, prompt)
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
          : [
              "Output EVERY file using the exact format: ```filename:src/App.tsx (path in the fence opening).",
              "Always output src/App.tsx, src/index.tsx, and package.json — even if unchanged.",
              "Keep ALL existing functionality that the user did NOT ask to change.",
              "Preserve the existing design system, color palette, and component structure.",
              "Use inline styles or plain src/styles.css — never Tailwind.",
            ]
        : [
            "Output EVERY file using the exact format: ```filename:src/App.tsx (path in the fence opening).",
            "Always include src/App.tsx, src/index.tsx, and package.json.",
            "src/App.tsx must have `export default function App()`.",
            "Use React with TypeScript. Style with inline styles or a plain src/styles.css — never Tailwind.",
          ];

    // ── Tell frontend what's being built (original prompt, never expanded) ──
    server?.emitToRoom(sessionId, "build:thinking", { text: `Building: ${prompt}`, sessionId });
    server?.emitToRoom(sessionId, "build:thinking", {
      text: hasExistingCode
        ? `Editing existing project (${Object.keys(existingFiles).length} files loaded)...`
        : "Starting new build...",
      sessionId,
    });
    server?.emitToRoom(sessionId, "build:thinking", { text: "Calling AI model...", sessionId });

    // ── Dispatch frontend agent ─────────────────────────────────────────────
    const dispatcher = getDispatcher();
    const result = await dispatcher.dispatch({
      agentType: "frontend",
      task: {
        description: taskDescription,
        requirements,
        outputFormat: "code",
      },
      sessionId,
      userId,
      projectId,
    });

    // ── Check for cancellation ──────────────────────────────────────────────
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
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

    const filesToWrite: ParsedFile[] =
      parsedFiles.length > 0
        ? parsedFiles
        : [{ path: "output.md", code: result.content }];

    const writtenPaths: string[] = [];
    const totalFiles = filesToWrite.length;

    for (let idx = 0; idx < filesToWrite.length; idx++) {
      if (cancelledSessions.has(sessionId)) break;

      const file = filesToWrite[idx];
      if (!file) continue;
      const { path: filePath, code } = file;

      // Sanitise path: strip leading slashes / traversal attempts
      const safePath = filePath.replace(/^[\\/]+/, "").replace(/\.\.\//g, "");
      const fullPath = join(outputDir, safePath);
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
          server?.emitToRoom(sessionId, "build:thinking", {
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
    server?.emitToRoom(sessionId, "build:complete", {
      sessionId,
      files: allFiles,
      previewUrl: `/api/build/${sessionId}/preview`,
      totalFiles: Object.keys(allFiles).length,
    });

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

  // ── Atomically deduct credits ─────────────────────────────────────────────
  await deductCredits(authUser.id, FAST_BUILD_CREDIT_COST);
  console.log(`[FAST t+${Date.now()-t0}ms] credits deducted`);

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
    setImmediate(() => {
      runFastBuild(sessionId, projectId, prompt, userId).catch((err) => {
        console.error(err);
        refundCredits(userId, FAST_BUILD_CREDIT_COST).catch(console.error);
      });
    });
  } catch (err) {
    // Refund credits if session creation failed (DB insert or project update)
    await refundCredits(authUser.id, FAST_BUILD_CREDIT_COST);
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
