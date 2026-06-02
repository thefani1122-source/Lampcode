export interface ParsedFile {
  path: string;
  code: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Single-word language hints that appear after ``` but are NOT file paths
const LANG_HINTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "json", "json5", "jsonc",
  "css", "scss", "sass", "less",
  "html", "xml", "svg",
  "md", "mdx", "markdown",
  "bash", "sh", "zsh", "shell",
  "python", "py", "rb", "ruby", "go", "rust", "java", "c", "cpp", "cs",
  "yaml", "yml", "toml", "ini", "env",
  "sql", "graphql", "gql",
  "plaintext", "text", "txt", "diff", "patch",
]);

// Backend / full-stack files. These run server-side (Node), NOT in Sandpack,
// so the Sandpack validator must NOT flag their server-side imports as errors.
const BACKEND_FILES = new Set([
  "src/db/schema.ts",
  "src/db/seed.ts",
  "src/server/routes/api.ts",
  "src/server/auth.ts",
]);

/** True when a path is a server-side full-stack file (not bundled by Sandpack). */
export function isBackendFile(path: string): boolean {
  return BACKEND_FILES.has(path) || path.startsWith("src/server/") || path.startsWith("src/db/");
}

// Files that belong at project root, not under src/
const ROOT_FILES = new Set([
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "index.html", "vite.config.ts", "vite.config.js",
  "tsconfig.json", "tsconfig.node.json", "tsconfig.app.json",
  ".env", ".env.local", ".gitignore", ".eslintrc", ".eslintrc.json",
  "README.md", "tailwind.config.ts", "tailwind.config.js",
  "postcss.config.js", "postcss.config.ts",
]);

// ── Default generated file contents ──────────────────────────────────────────

const DEFAULT_INDEX_TSX = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;

const DEFAULT_PACKAGE_JSON = JSON.stringify(
  {
    name: "sandpack-app",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: {
      react: "^18.2.0",
      "react-dom": "^18.2.0",
    },
    devDependencies: {
      "@types/react": "^18.2.0",
      "@types/react-dom": "^18.2.0",
      typescript: "^5.0.0",
    },
  },
  null,
  2,
);

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Extract a file path from the opening fence line, e.g.:
 *   ```filename:src/App.tsx   → "src/App.tsx"
 *   ```src/App.tsx            → "src/App.tsx"
 *   ```tsx                    → null  (language hint only)
 */
function extractFencePath(fenceLine: string): string | null {
  const after = fenceLine.replace(/^(?:```|~~~)/, "").trim();
  if (!after) return null;

  // filename: prefix is unambiguous
  if (after.startsWith("filename:")) {
    return after.slice("filename:".length).trim() || null;
  }

  // Pure language hint → not a path
  if (LANG_HINTS.has(after.toLowerCase())) return null;

  // Contains a slash → definitely a path
  if (after.includes("/")) return after;

  // Bare name with a recognisable extension → treat as path
  if (/\.[a-zA-Z0-9]{1,10}$/.test(after)) return after;

  return null;
}

/**
 * Normalise a raw path extracted from LLM output:
 *   "/src/App.tsx" → "src/App.tsx"   (strip leading slash)
 *   "App.tsx"      → "src/App.tsx"   (add src/ for bare source files)
 *   "package.json" → "package.json"  (root file, unchanged)
 */
function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^\/+/, "").replace(/^\.\//, "");
  // Bare filename with no directory: promote source files to src/
  if (
    !p.includes("/") &&
    !ROOT_FILES.has(p) &&
    /\.(tsx|ts|jsx|js|css|scss|sass|less)$/.test(p)
  ) {
    p = `src/${p}`;
  }
  return p;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseFilesFromContent(content: string): ParsedFile[] {
  console.log('[parser] input length:', content.length)
  console.log('[parser] fence count:', (content.match(/```/g) ?? []).length)
  console.log('[parser] first 500 chars:', content.slice(0, 500))
  const rawFiles: ParsedFile[] = [];
  const lines = content.split("\n");
  let i = 0;

  // Regex for a heading line before a fence that looks like a file path
  const pathLineRe =
    /^(?:#{1,4}\s+(?:File:\s+)?|>\s*)?[`*_]{0,3}([^\s`*_<>|]+\.[a-zA-Z0-9]{1,10})[`*_]{0,3}:?\s*$/;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (/^(?:```|~~~)/.test(line)) {
      // 1. Try to extract path from the fence line itself (```filename:path or ```path)
      let filePath: string | null = extractFencePath(line);

      // 2. If fence has no path, look backwards up to 3 lines for a heading
      if (filePath === null) {
        for (let back = 1; back <= 3; back++) {
          const prevLine = lines[i - back] ?? "";
          if (prevLine.trim() === "") continue;
          const m = pathLineRe.exec(prevLine.trim());
          if (m?.[1]) { filePath = m[1]; break; }
          if (/^(?:```|~~~)/.test(prevLine) || back === 1) break;
        }
      }

      // Collect code until closing fence
      i++;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const codeLine = lines[i] ?? "";
        if (/^(?:```|~~~)/.test(codeLine)) { i++; break; }
        codeLines.push(codeLine);
        i++;
      }
      const code = codeLines.join("\n").trim();
      if (code.length === 0) continue;

      // 3. Fallback: first line of code block as a comment path
      if (filePath === null) {
        const firstCodeLine = codeLines[0] ?? "";
        const commentMatch =
          firstCodeLine.match(/^\/\/\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/) ??
          firstCodeLine.match(/^#\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/);
        if (commentMatch?.[1]) {
          filePath = commentMatch[1];
          const trimmedCode = codeLines.slice(1).join("\n").trim();
          if (trimmedCode.length > 0) {
            rawFiles.push({ path: normalizePath(filePath), code: trimmedCode });
          }
          continue;
        }
      }

      // 4. Orphan block heuristic: no path found anywhere, but the code looks
      //    like a React component — claim it as src/App.tsx if not yet seen.
      if (filePath === null) {
        const looksLikeAppComponent =
          /export\s+default\s+function\s+App\b/.test(code) ||
          /export\s+default\s+App\b/.test(code) ||
          (/export\s+default/.test(code) && /React|jsx|tsx/.test(code) && code.length > 200);
        if (looksLikeAppComponent) {
          filePath = "src/App.tsx";
          console.log('[parser] orphan block assigned to src/App.tsx (heuristic match)')
        }
      }

      if (filePath !== null) {
        rawFiles.push({ path: normalizePath(filePath), code });
      }
      continue;
    }

    i++;
  }

  // ── Post-process: ensure Sandpack required files exist ────────────────────

  const fileMap = new Map<string, string>(rawFiles.map((f) => [f.path, f.code]));

  // Promote bare App.tsx to src/App.tsx if src/App.tsx is absent
  if (!fileMap.has("src/App.tsx") && fileMap.has("App.tsx")) {
    fileMap.set("src/App.tsx", fileMap.get("App.tsx")!);
    fileMap.delete("App.tsx");
  }

  // Generate fallback src/App.tsx if still missing after all parse strategies
  if (!fileMap.has("src/App.tsx")) {
    if (content.length > 500) {
      console.error('[parser] CRITICAL: App.tsx missing from output of', content.length, 'chars')
      console.log('[parser] Files found:', Array.from(fileMap.keys()))
      console.log('[parser] First 1000 chars:', content.slice(0, 1000))
    }
    console.log('[parser] WARNING: src/App.tsx not found — inserting fallback placeholder')
    fileMap.set("src/App.tsx", `import React from 'react';
export default function App() {
  return (
    <div style={{ padding: 20, color: 'white', background: '#0a0a0f', minHeight: '100vh' }}>
      <h1>App loaded successfully</h1>
      <p>The main component could not be extracted. Please try again.</p>
    </div>
  );
}`);
  }

  // Generate src/index.tsx if absent
  if (!fileMap.has("src/index.tsx")) {
    fileMap.set("src/index.tsx", DEFAULT_INDEX_TSX);
  }

  // Generate package.json if absent
  if (!fileMap.has("package.json")) {
    fileMap.set("package.json", DEFAULT_PACKAGE_JSON);
  }

  const result = Array.from(fileMap.entries()).map(([path, code]) => ({ path, code }));
  console.log('[parser] extracted:', result.map((f) => f.path))
  return result;
}

// ── Surgical edit parser ──────────────────────────────────────────────────────

export interface SurgicalEdit {
  description: string;
  content: string;
}

/**
 * Extract BEGIN_EDIT/END_EDIT blocks from a parsed file's code.
 * Returns empty array when the file uses full-file output (no markers).
 */
export function parseSurgicalEdits(code: string): SurgicalEdit[] {
  const edits: SurgicalEdit[] = [];
  const lines = code.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const beginMatch = /^\s*\/\/\s*BEGIN_EDIT\s*:?\s*(.*)$/.exec(line);
    if (beginMatch) {
      const description = (beginMatch[1] ?? "").trim();
      const contentLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cl = lines[i] ?? "";
        if (/^\s*\/\/\s*END_EDIT\s*/.test(cl)) { i++; break; }
        contentLines.push(cl);
        i++;
      }
      const content = contentLines.join("\n").trim();
      if (content.length > 0) edits.push({ description, content });
    } else {
      i++;
    }
  }

  return edits;
}

/**
 * Apply one surgical edit to existing file content.
 * Finds the anchor (first non-comment, non-empty line of the new content) in the
 * existing file, then replaces the matching block using brace-depth counting.
 * Falls back to appending if the anchor is not found — no data is ever lost.
 */
export function applySurgicalEdit(
  existingContent: string,
  edit: SurgicalEdit,
): string {
  const newLines = edit.content.split("\n");
  if (newLines.length === 0 || edit.content.trim() === "") return existingContent;

  // Anchor: first non-empty, non-comment line
  const anchorLine = newLines.find((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("//");
  });
  if (!anchorLine) return existingContent;

  const existingLines = existingContent.split("\n");
  const anchorIdx = existingLines.findIndex((l) => l.trim() === anchorLine.trim());

  if (anchorIdx === -1) {
    // Section not found — append as a new block (safe: no data loss)
    return existingContent.trimEnd() + "\n\n" + edit.content + "\n";
  }

  // Walk forward from the anchor to find the end of the block using brace depth.
  // Works for CSS rules (:root { }) and TS/JS function bodies.
  let depth = 0;
  let foundOpen = false;
  let endIdx = anchorIdx;

  for (let i = anchorIdx; i < existingLines.length; i++) {
    for (const ch of (existingLines[i] ?? "")) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
    }
    if (foundOpen && depth <= 0) { endIdx = i; break; }
    // No braces found at all: treat anchor as a single-line section
    if (!foundOpen && i > anchorIdx) { endIdx = anchorIdx; break; }
  }

  return [
    ...existingLines.slice(0, anchorIdx),
    ...newLines,
    ...existingLines.slice(endIdx + 1),
  ].join("\n");
}

// ── Component addition parser ─────────────────────────────────────────────────

export interface ComponentAddition {
  componentName: string;
  componentCode: string;   // complete function body
  integrationTag: string;  // e.g. "<ProfileSection />"
  insertAfter: string | null; // PascalCase component name, or null = append
}

/**
 * Parse a component-addition code block that contains // NEW COMPONENT: and
 * // INTEGRATION: markers. Returns null when neither marker is present.
 */
export function parseComponentAddition(code: string): ComponentAddition | null {
  // Must start with the marker (LLM is instructed to output it first)
  const compRe = /\/\/\s*NEW COMPONENT:\s*(\w+)[^\n]*\n([\s\S]+?)(?=\/\/\s*INTEGRATION:)/i;
  const compMatch = compRe.exec(code);
  if (!compMatch) return null;

  const componentName = (compMatch[1] ?? "").trim();
  const componentCode = (compMatch[2] ?? "").trim();
  if (!componentName || !componentCode) return null;

  // Extract the JSX tag that follows // INTEGRATION:
  const intRe = /\/\/\s*INTEGRATION:[^\n]*\n([^\n]+)/i;
  const intMatch = intRe.exec(code);
  const integrationTag = (intMatch?.[1] ?? "").trim();

  // Extract "after <SomeComponent" from the integration comment
  const afterMatch = /\/\/\s*INTEGRATION:[^\n]*after\s+<([A-Z][A-Za-z0-9]+)/i.exec(code);
  const insertAfter = afterMatch?.[1] ?? null;

  return { componentName, componentCode, integrationTag, insertAfter };
}

/**
 * Splice a new component into an existing App.tsx string.
 *
 * Step 1: Insert the function body immediately before "export default function App".
 * Step 2: Insert the JSX tag after the specified sibling component (or before the
 *         last closing tag of the root element if no sibling is named).
 *
 * Returns null when the existing file structure can't be parsed safely.
 */
export function applyComponentAddition(
  existingAppTsx: string,
  addition: ComponentAddition,
): string | null {
  // ── Step 1: insert function before "export default function App" ────────────
  const exportDefaultRe = /(\nexport\s+default\s+function\s+App\b)/;
  if (!exportDefaultRe.test(existingAppTsx)) return null;

  let result = existingAppTsx.replace(
    exportDefaultRe,
    `\n// ${addition.componentName}\n${addition.componentCode}\n$1`,
  );

  // ── Step 2: insert JSX tag ──────────────────────────────────────────────────
  if (addition.integrationTag) {
    let inserted = false;

    if (addition.insertAfter) {
      // Insert on the line immediately after the named sibling component tag
      const siblingRe = new RegExp(
        `(<${addition.insertAfter}\\b[^>]*(?:\\/>|>[^<]*<\\/${addition.insertAfter}>))`,
        "s",
      );
      if (siblingRe.test(result)) {
        result = result.replace(siblingRe, `$1\n          ${addition.integrationTag}`);
        inserted = true;
      }
    }

    if (!inserted) {
      // Fallback: prepend the new tag immediately before the first
      // "          </div>);" style closing line of the App's return block.
      const closingTagRe = /([ \t]{2,})<\/[a-z][A-Za-z0-9]*>\s*\)\s*;/;
      result = result.replace(closingTagRe, (m, indent) =>
        `${indent}${addition.integrationTag}\n${m}`,
      );
    }
  }

  return result;
}

/**
 * Remove any stray BEGIN_EDIT / END_EDIT / CHANGED: comment lines from code.
 * Called on every file before it is written to disk so no edit markers
 * ever reach Sandpack, even if the LLM scattered them outside proper blocks.
 */
export function stripEditMarkers(code: string): string {
  return code
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return (
        !/^\/\/\s*BEGIN_EDIT\b/.test(t) &&
        !/^\/\/\s*END_EDIT\b/.test(t) &&
        !/^\/\/\s*CHANGED:/.test(t)
      );
    })
    .join("\n");
}

// ── Sandpack validator ────────────────────────────────────────────────────────

const SERVER_IMPORT_RE =
  /from\s+['"](?:fs|path|os|crypto|child_process|net|dns|tls|stream|buffer|util|events|assert|url|querystring|http|https|http2)['"]/;

/**
 * Validate that a file map is safe to load into Sandpack.
 * Returns the (possibly unmodified) files alongside any errors found.
 */
export function validateSandpackFiles(files: Record<string, string>): {
  valid: boolean;
  errors: string[];
  files: Record<string, string>;
} {
  const errors: string[] = [];

  if (!files["src/App.tsx"]) errors.push("Missing src/App.tsx");
  if (!files["src/index.tsx"]) errors.push("Missing src/index.tsx");
  if (!files["package.json"]) errors.push("Missing package.json");

  if (files["src/App.tsx"] && !/export\s+default/.test(files["src/App.tsx"])) {
    errors.push("src/App.tsx has no default export");
  }

  for (const [filePath, content] of Object.entries(files)) {
    if (filePath === "package.json") continue;
    // Backend files legitimately import fs/path/etc. — they run in Node, not Sandpack.
    if (isBackendFile(filePath)) continue;
    if (SERVER_IMPORT_RE.test(content)) {
      errors.push(`${filePath} contains a server-side import`);
    }
  }

  return { valid: errors.length === 0, errors, files };
}
