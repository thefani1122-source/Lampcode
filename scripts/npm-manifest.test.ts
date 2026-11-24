/**
 * The prompt's package manifests must come from the TEMPLATE, not from a
 * hardcoded sentence.
 *
 * WHY THIS EXISTS. `buildNpmManifest`, `buildNextNpmManifest` and
 * `buildPipManifest` parse `e2b-template/template.ts` and
 * `template-nextjs-ubuntu.ts` at runtime so there is no second, hand-maintained
 * package list in the prompt (CLAUDE.md: "prompt-vs-reality drift is the #1 bug
 * class here"). All three regexes were silently broken and every build fell to
 * the `catch` fallback instead:
 *
 *   - `[\\s\\S]` in a regex LITERAL is the class {backslash, s, S}, not "any
 *     character", and the trailing `` `\\n `` was backtick + backslash + n. So
 *     the Vite and Next.js matches could never succeed.
 *   - `\[([^\]]+)\]` stopped at the `]` inside `'uvicorn[standard]'`, before it
 *     ever reached `] as const`, so the Python match could never succeed either.
 *
 * Nothing failed loudly — each one logged a warning and served a short generic
 * sentence that omits hono, @hono/node-server, zod, ws, react-router-dom and
 * every Radix primitive. The model was therefore told less than the truth about
 * its own sandbox on every single build.
 *
 * These assertions go through the real PromptBuilder, not the private helpers,
 * so they also cover the `{{NPM_MANIFEST}}` / `{{PIP_MANIFEST}}` substitution.
 * A regex that breaks again fails here instead of degrading quietly.
 */
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/agents/prompt-builder.js";

/** The markers build.ts appends; `selectedBuildMarker` reads only these. */
function fullstackDescription(opts: {
  framework: "react" | "nextjs";
  database: string;
  backendRuntime: "node" | "python";
}): string {
  return [
    "FULLSTACK BUILD: build a small app",
    "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
    `LAMPCode_SELECTED_FRAMEWORK: ${opts.framework}`,
    `LAMPCode_SELECTED_DATABASE: ${opts.database}`,
    `LAMPCode_SELECTED_BACKEND_RUNTIME: ${opts.backendRuntime}`,
  ].join("\n");
}

async function systemPromptFor(description: string): Promise<string> {
  const built = await new PromptBuilder().build(
    "frontend",
    { description, outputFormat: "prose", toolsEnabled: true, agenticBuild: true },
    { projectId: "npm-manifest-test", userId: "npm-manifest-test", mode: "fast", prompt: description },
  );
  return built.systemPrompt;
}

// ── React/Vite + Node ────────────────────────────────────────────────────────
const reactNode = await systemPromptFor(
  fullstackDescription({ framework: "react", database: "supabase", backendRuntime: "node" }),
);

assert.match(
  reactNode,
  /PRE-INSTALLED IN THIS REACT\/VITE SANDBOX:/,
  "the Vite manifest must be parsed out of template.ts, not replaced by the catch fallback",
);
// Packages that are in VITE_PKG_JSON and that the generic fallback never names.
// A build that is not told about these either reimplements them or imports
// something it believes is missing.
for (const pkg of ["hono", "@hono/node-server", "zod", "ws", "react-router-dom", "@radix-ui/react-dialog"]) {
  assert.ok(
    reactNode.includes(pkg),
    `Vite manifest is missing ${pkg}, which template.ts installs`,
  );
}
// DB/auth libraries are described in their own sections; listing them here too
// would state the same fact under two different framings.
for (const pkg of ["@supabase/supabase-js", "mongoose", "jsonwebtoken", "bcryptjs"]) {
  assert.ok(
    !new RegExp(`PRE-INSTALLED IN THIS REACT/VITE SANDBOX:[^\\n]*${pkg.replace(/[/@.*+?^${}()|[\]\\]/g, "\\$&")}`).test(reactNode),
    `${pkg} belongs to the DATABASE/AUTH sections, not the available-packages list`,
  );
}
assert.ok(
  !reactNode.includes("Optional packages are installed only when imported."),
  "that sentence is only in the catch fallbacks — its presence means a manifest failed to parse",
);
assert.ok(
  !/\{\{(NPM|PIP)_MANIFEST\}\}/.test(reactNode),
  "an unsubstituted placeholder would reach the model verbatim",
);
// react-router-dom IS in VITE_PKG_JSON and the template npm-installs it, so the
// "how to add a dependency" rule must not use it as its not-pre-installed example.
assert.ok(
  !/not pre-installed \(react-router-dom/.test(reactNode),
  "the prompt must not call react-router-dom missing while the manifest lists it as present",
);

// ── React/Vite + Python ──────────────────────────────────────────────────────
const reactPython = await systemPromptFor(
  fullstackDescription({ framework: "react", database: "supabase", backendRuntime: "python" }),
);
assert.match(
  reactPython,
  /PRE-INSTALLED PYTHON ESSENTIALS in \/opt\/lampcode-python:/,
  "the pip manifest must be parsed out of PYTHON_BASE_PACKAGES",
);
// The exact token the old `[^\]]+` class choked on.
assert.ok(
  reactPython.includes("uvicorn[standard]"),
  "uvicorn[standard] is the entry whose nested ] broke the previous regex",
);
for (const pkg of ["fastapi", "supabase", "python-dotenv"]) {
  assert.ok(reactPython.includes(pkg), `pip manifest is missing ${pkg}`);
}

// ── Next.js ──────────────────────────────────────────────────────────────────
const nextjs = await systemPromptFor(
  fullstackDescription({ framework: "nextjs", database: "supabase", backendRuntime: "node" }),
);
assert.match(
  nextjs,
  /PRE-INSTALLED IN THIS NEXT\.JS SANDBOX:/,
  "the Next.js manifest must be parsed out of template-nextjs-ubuntu.ts",
);
assert.ok(
  /PRE-INSTALLED IN THIS NEXT\.JS SANDBOX:[^\n]*\bnext\b/.test(nextjs),
  "the Next.js manifest must name next itself",
);
assert.ok(
  !nextjs.includes("Optional packages are installed only when imported."),
  "the Next.js manifest fell back to its hardcoded sentence",
);

console.log("Package manifest prompt tests passed.");
