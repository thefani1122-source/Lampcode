import { transform } from "esbuild";

export interface SyntaxError {
  path: string;
  message: string;
}

// Only these are real source files we can parse. Config/markup/data files are
// skipped (esbuild can't parse them and they rarely carry JSX syntax errors).
const LOADER_BY_EXT: Record<string, "tsx" | "ts" | "jsx" | "js"> = {
  ".tsx": "tsx",
  ".ts": "ts",
  ".jsx": "jsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
};

function loaderFor(path: string): "tsx" | "ts" | "jsx" | "js" | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return LOADER_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * Validates generated source files by actually parsing them with esbuild — the
 * same parser Vite/Sandpack use under the hood. Catches the real cause of
 * "Preview failed to load: syntax error": truncated files, unclosed JSX,
 * unbalanced braces, stray tokens. In-process and fast (~ms per file); needs no
 * app node_modules. Returns one entry per file that fails to parse.
 */
export async function validateSyntax(
  files: { path: string; code: string }[],
): Promise<SyntaxError[]> {
  const checks = files.map(async (f) => {
    const loader = loaderFor(f.path);
    if (!loader || !f.code.trim()) return null;
    try {
      await transform(f.code, { loader, sourcefile: f.path, logLevel: "silent" });
      return null;
    } catch (err) {
      // esbuild errors carry a structured `errors` array; fall back to message.
      const e = err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }>; message?: string };
      const first = e.errors?.[0];
      const where = first?.location?.line ? ` (line ${first.location.line})` : "";
      const message = (first?.text ?? e.message ?? "syntax error").trim() + where;
      return { path: f.path, message } satisfies SyntaxError;
    }
  });
  const results = await Promise.all(checks);
  return results.filter((r): r is SyntaxError => r !== null);
}
