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
    if (SERVER_IMPORT_RE.test(content)) {
      errors.push(`${filePath} contains a server-side import`);
    }
  }

  return { valid: errors.length === 0, errors, files };
}
