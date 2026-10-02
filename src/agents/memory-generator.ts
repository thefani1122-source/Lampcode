/**
 * Project memory, derived from the project itself — no model call.
 *
 * This replaces a Haiku dispatch that read 8 KB of concatenated code and wrote
 * a prose summary. It logged `[memory-generator] failed: Could not resolve
 * authentication method` on every single build, because it built an Anthropic
 * client from `config.ANTHROPIC_API_KEY` and that is not set on Railway. It
 * degraded quietly (returning the old memory), so no build ever failed and
 * nobody noticed that memory had stopped being written. 53 of 311 projects
 * carry memory in its old shape, from whenever the key was present.
 *
 * Everything the old prompt asked a model to infer is already knowable from
 * the files: which packages are imported, what the design tokens are, which
 * files exist and what they export, what tables the SQL declares. Deriving it
 * costs nothing, cannot fail, cannot hallucinate a component that does not
 * exist, and works with no credentials — which is the whole point, since the
 * absence of credentials is why memory was missing.
 *
 * What a model genuinely did better was "what was built, and why". That is not
 * inferred here either: the user's own prompts are kept verbatim instead. Their
 * words beat any summary of their words.
 *
 * Memory is injected verbatim into every edit's system prompt, beside the file
 * manifest. So it answers WHAT and WHY; the manifest answers WHERE. Repeating
 * the manifest here would spend the edit's context twice on the same facts.
 */

/** Marks the prompt-history list so the next build can read its own output
 *  back and append to it. Parsing our own markdown is circular, but the
 *  alternative is another column or another query, and a failed parse degrades
 *  to "current intent only", which is still useful. */
const HISTORY_HEADING = "## What the user asked for";

/** Keep memory small — it goes into the system prompt of every edit, where it
 *  competes with the files the model actually needs to read. */
const MAX_HISTORY_ENTRIES = 8;
const MAX_PROMPT_CHARS = 240;
const MAX_LISTED_FILES = 12;

export type ProjectMemoryInput = {
  /** The project's files as they stand after this build. */
  files: Record<string, string>;
  /** This build's prompt, in the user's own words. */
  prompt: string;
  /** The previous memory, for the prompt history only — every other section is
   *  re-derived, so stale facts cannot survive a build. */
  existingMemory: string | null;
};

// ── Prompt history ────────────────────────────────────────────────────────────

function trimPrompt(p: string): string {
  const flat = p.replace(/\s+/g, " ").trim();
  return flat.length > MAX_PROMPT_CHARS ? `${flat.slice(0, MAX_PROMPT_CHARS - 1)}…` : flat;
}

/** Read the numbered prompt list back out of a previous memory document. */
export function parseHistory(existingMemory: string | null): string[] {
  if (!existingMemory) return [];
  const start = existingMemory.indexOf(HISTORY_HEADING);
  if (start === -1) return [];
  const after = existingMemory.slice(start + HISTORY_HEADING.length);
  const end = after.indexOf("\n## ");
  const section = end === -1 ? after : after.slice(0, end);
  return section
    .split("\n")
    .map((l) => /^\s*\d+\.\s+(.*)$/.exec(l)?.[1]?.trim() ?? "")
    .filter((l) => l.length > 0);
}

// ── Stack detection ───────────────────────────────────────────────────────────

/** What this project is actually built out of, by what its code imports. The
 *  old prompt asked a model to report the stack; a model can only guess it from
 *  the same imports, and can get it wrong. */
export function detectStack(files: Record<string, string>): string[] {
  const paths = Object.keys(files);
  const code = Object.entries(files)
    .filter(([p]) => /\.(tsx?|jsx?|py)$/.test(p))
    .map(([, c]) => c)
    .join("\n");

  const has = (re: RegExp) => re.test(code);
  const stack: string[] = [];

  const frontend = ["React + Vite"];
  if (has(/@tanstack\/react-query/)) frontend.push("TanStack Query");
  if (has(/from ["']motion|framer-motion/)) frontend.push("Motion");
  if (has(/from ["']gsap/)) frontend.push("GSAP");
  if (has(/@react-three\/fiber|from ["']three/)) frontend.push("Three.js");
  if (has(/from ["']recharts/)) frontend.push("Recharts");
  stack.push(`Frontend: ${frontend.join(", ")}`);

  const pythonBackend = paths.some((p) => p.endsWith("main.py") || p.includes("src/server/main.py"));
  const nodeBackend = paths.some((p) => p.startsWith("src/server/") && /\.tsx?$/.test(p));
  if (pythonBackend) stack.push("Backend: FastAPI on :3001 (uvicorn)");
  else if (nodeBackend) stack.push("Backend: Hono on :3001");
  else stack.push("Backend: none — frontend only");

  const data: string[] = [];
  if (has(/@supabase\/supabase-js|from ["']supabase/)) data.push("Supabase");
  if (has(/from ["']mongoose/)) data.push("MongoDB (mongoose)");
  if (has(/localStorage/)) data.push("localStorage");
  stack.push(`Data: ${data.length > 0 ? data.join(", ") : "none — in-memory only"}`);

  stack.push("Styling: Tailwind v4 with the template's design tokens");
  return stack;
}

// ── SQL tables ────────────────────────────────────────────────────────────────

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([\w.]+)["'`]?/gi;

/** Table names the project's SQL declares. Regex, not a parser: this reads
 *  generated DDL, not arbitrary SQL, and a name list is all memory needs. */
export function extractTables(files: Record<string, string>): string[] {
  const sql = Object.entries(files)
    .filter(([p]) => p.endsWith(".sql"))
    .map(([, c]) => c)
    .join("\n");
  if (sql.trim() === "") return [];

  const names: string[] = [];
  CREATE_TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_TABLE_RE.exec(sql)) !== null) {
    const name = (m[1] ?? "").replace(/^public\./i, "");
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

/** The project's own :root block, when it has overridden the template's. The
 *  edit prompt already tells the model to keep the existing palette; this is
 *  what "the existing palette" actually is. */
export function extractTokens(files: Record<string, string>): string | null {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".css")) continue;
    const match = /:root\s*\{([^}]+)\}/s.exec(content);
    if (!match) continue;
    const vars = (match[1] ?? "")
      .split(";")
      .map((l) => l.trim())
      .filter((l) => /^--[\w-]+\s*:/.test(l));
    if (vars.length > 0) return vars.join("; ");
  }
  return null;
}

// ── Structure ─────────────────────────────────────────────────────────────────

function listFiles(paths: string[]): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, MAX_LISTED_FILES);
  const extra = paths.length - shown.length;
  return shown.join(", ") + (extra > 0 ? `, +${extra} more` : "");
}

// ── Document ──────────────────────────────────────────────────────────────────

/**
 * Build the memory document. Pure, synchronous, and incapable of failing — the
 * old version was `async` because it made a network call, and keeping that
 * signature would have implied one.
 */
export function generateProjectMemory(input: ProjectMemoryInput): string {
  const { files, prompt, existingMemory } = input;

  const history = [...parseHistory(existingMemory), trimPrompt(prompt)]
    .filter((p) => p.length > 0)
    .slice(-MAX_HISTORY_ENTRIES);

  const paths = Object.keys(files).sort();
  const isSource = (p: string) => /\.(tsx?|jsx?|py)$/.test(p);
  const tests = paths.filter((p) => /\.(test|spec)\.(tsx?|jsx?)$/.test(p));
  const isTest = (p: string) => tests.includes(p);
  const views = paths.filter((p) => !isTest(p) && /\/(views|pages|screens)\//.test(p));
  const components = paths.filter((p) => !isTest(p) && /\/components\//.test(p));
  const logic = paths.filter((p) => !isTest(p) && /\/(lib|utils|hooks|store|state)\//.test(p) && isSource(p));
  const serverFiles = paths.filter((p) => p.startsWith("src/server/"));

  const tables = extractTables(files);
  const tokens = extractTokens(files);

  const sections: string[] = [
    `# Project Memory`,
    `Derived from the project's own files — no model call. Last updated: ${new Date().toISOString()}`,
    "",
    HISTORY_HEADING,
    "In the user's own words, oldest first. The latest entry is the most recent change.",
    ...history.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Stack",
    ...detectStack(files).map((s) => `- ${s}`),
    "",
    "## Structure",
    `- source files: ${paths.filter(isSource).filter((p) => !isTest(p)).length}`,
    `- views: ${listFiles(views)}`,
    `- components: ${listFiles(components)}`,
    `- logic modules: ${listFiles(logic)}`,
    `- tests: ${listFiles(tests)}`,
  ];

  if (serverFiles.length > 0) {
    sections.push(`- backend files: ${listFiles(serverFiles)}`);
  }

  sections.push(
    "",
    "## Data",
    tables.length > 0
      ? `- tables declared in SQL: ${tables.join(", ")}`
      : "- no SQL schema in this project",
  );

  if (tokens) {
    sections.push(
      "",
      "## Design tokens in use",
      "Keep these. An edit must not change a value the user did not ask to change.",
      tokens,
    );
  }

  return sections.join("\n");
}
