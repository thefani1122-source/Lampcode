/**
 * Deploy a generated app to the USER's own Vercel account, through their own
 * connected Vercel MCP.
 *
 * Never Lampcode's account — that was the owner's decision and it is also the
 * only version that scales: the app, its domain, its logs and its bill belong
 * to the person who asked for it, and Lampcode never holds a credential it
 * would have to be trusted with.
 *
 * ## Why the whole app, not just the frontend
 *
 * A Lampcode fullstack app is two things: a Vite frontend and a Hono (or
 * FastAPI) backend that the preview runs on :3001. Deploying only the frontend
 * ships a site where no data loads — the exact bug fixed on 2026-10-11, where
 * relative `/api/...` calls worked solely because Vite's DEV server proxies
 * them. So one deployment carries both: Vite builds to `dist/`, and the whole
 * Hono app is served from `api/` as a function. `/api/...` is then same-origin
 * in production, which is why the generated `API_BASE` can stay empty and
 * nothing about the frontend has to change between preview and production.
 *
 * ## What is verified here, and the one thing that is not
 *
 * Checked against Vercel's own docs and the installed packages, not recalled:
 *
 *  - A file in `api/` becomes a function with **no configuration**, exporting
 *    `export default { fetch(request) {…} }`.
 *  - A Hono instance already exposes `.fetch`, so `export default app` IS that
 *    shape. **No adapter is used** — and deliberately not `hono/vercel`, whose
 *    own type declarations say: *"`hono/vercel` will be removed in v5. Install
 *    `@hono/vercel` and import from there instead."* Depending on a deprecated
 *    adapter would also have meant a new package in the E2B template, a rebuild
 *    and `verify-template.ts` (trap 6). `export default app` needs none of it.
 *  - `smoke.ts` is real and makes actual requests.
 *
 * **Unverified, and it cannot be verified without a real Vercel account:**
 * whether `api/[...route].ts` catches every `/api/*` path in a project that is
 * ALSO a Vite build. No source settles the precedence. It is therefore confined
 * to `vercelScaffold` below — one function, one fix — and `smoke.ts` runs after
 * every deploy precisely so a routing mistake is REPORTED rather than passed off
 * as a success. A deploy that returns a URL proves the API call worked, not that
 * the app loads; that distinction is the whole reason `verify/` exists.
 */

import { callMcpTool } from "../mcp/call-tool.js";
import { logger } from "../server/logger.js";
import { runSmokeTests, type SmokeTestOptions } from "./smoke.js";
import { nextjsSmokeTargets, nextjsVercelScaffold } from "./nextjs-scaffold.js";
import { PREBAKED_UI_PRIMITIVES, QUERY_CLIENT_TS, STYLES_CSS, UTILS_TS } from "./shared-scaffold-assets.js";

/** The user's own Vercel credential, from their connected MCP row. Never
 *  logged, never sent to the model, never written into the sandbox. */
export interface VercelAuth {
  accessToken: string;
  /** Only needed when the token's default scope is not the target team. */
  teamId?: string | undefined;
}

/** What the generated app actually is, which decides the Vercel preset. */
export type DeployShape = "static" | "hono" | "fastapi" | "vite-fastapi" | "nextjs";

export interface DeployOutcome {
  ok: boolean;
  /** Present once Vercel reports a URL, even if the smoke checks then failed. */
  url?: string | undefined;
  /** Vercel's own state: READY, ERROR, CANCELED, BUILDING… */
  state?: string | undefined;
  shape: DeployShape;
  smoke?: Awaited<ReturnType<typeof runSmokeTests>> | undefined;
  /** Set when the deploy did not reach a serving URL. */
  error?: string | undefined;
}

const VERCEL_MCP_URL = "https://mcp.vercel.com";

/**
 * Which runtime this app ships, from the same signals the sandbox uses.
 *
 * `e2b-service.ts` decides how to start the backend with
 * `test -f src/server/index.ts` / `test -f src/server/main.py`. Reusing those
 * exact paths is the point: if the two ever disagree, an app boots in the
 * preview and deploys as the wrong thing, which is the drift class this repo
 * calls its #1 bug source. `app.ts` is accepted too, since that is where the
 * Hono app lives after the 2026-10-11 split.
 */
export function detectDeployShape(files: Record<string, string>): DeployShape {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  const hasNextApp = [
    "app/page.tsx", "app/page.jsx", "app/page.js", "app/layout.tsx", "app/layout.jsx", "app/layout.js",
    "src/app/page.tsx", "src/app/page.jsx", "src/app/page.js", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js",
  ].some(has);
  const hasViteFrontend = [
    "src/App.tsx", "src/App.jsx", "src/App.js",
    "src/index.tsx", "src/index.jsx", "src/main.tsx", "src/main.jsx", "index.html",
  ].some(has);
  if (hasNextApp) return "nextjs";
  // Vite UI and FastAPI server are separate services on the same public origin.
  if (has("src/server/main.py")) return hasViteFrontend ? "vite-fastapi" : "fastapi";
  if (has("src/server/app.ts") || has("src/server/index.ts")) return "hono";
  return "static";
}

/**
 * Probe only endpoints the generated app actually declares.
 *
 * A generic Vite app has no API server, and a Hono/FastAPI app is not required
 * to expose LampCode's optional health/auth examples. Assuming those endpoints
 * exist made healthy deployments fail smoke checks with 404s. For backend
 * projects, match explicit route declarations in the project server sources;
 * if a route is dynamic or composed from prefixes, do not guess its URL.
 */
export function deploySmokeTargets(
  shape: DeployShape,
  files: Record<string, string>,
): SmokeTestOptions {
  if (shape === "nextjs") return nextjsSmokeTargets(files);
  if (shape === "static") return { checkHealth: false, checkAuth: false };

  const serverSources = Object.entries(files)
    .filter(([path]) => path.startsWith("src/server/") && /\.(?:[cm]?[jt]sx?|py)$/i.test(path))
    .map(([, content]) => content);

  const declaresRoute = (methods: "get" | "get|post", endpoint: string): boolean => {
    // The endpoints and method allowlists are internal constants. Match common
    // Hono and FastAPI route syntax without executing generated source.
    const methodPattern = "(?:" + methods + "|route)";
    const pattern = new RegExp(
      "(?:\\.\\s*" + methodPattern + "|@[\\w.]+\\.\\s*" + methodPattern + "|add_api_route)" +
        "\\s*\\(\\s*[\\\"']" + endpoint + "[\\\"']",
      "i",
    );
    return serverSources.some(source => pattern.test(source));
  };

  return {
    checkHealth: declaresRoute("get", "/api/health"),
    checkAuth: declaresRoute("get|post", "/api/auth/login"),
  };
}

/**
 * The files Vercel needs that the MODEL never writes.
 *
 * Kept out of the prompt on purpose. The generated app stays deploy-agnostic —
 * it knows nothing about Vercel — and everything provider-specific is
 * synthesised here, where it can be corrected once without touching a prompt or
 * re-measuring a model. It is also the single place holding the one unverified
 * assumption in this file.
 */
/**
 * The build files a generated app needs on Vercel — which it has never carried.
 *
 * THE BUG THIS FIXES, found on the first real deployment, 2026-10-16. The log
 * read `files: 1`. Vercel was handed `src/App.tsx` and nothing to build it
 * with, and refused.
 *
 * The cause is structural, not a typo. `package.json`, `vite.config.ts`,
 * `index.html` and `tsconfig.json` are in `BAKED_FILES` — the E2B template owns
 * them, the model is forbidden to write them, and they are therefore NEVER in
 * `projectFiles` or `generatedFiles`. Everything that reads the file map sees
 * an app with no build setup. Inside the sandbox that is invisible, because
 * the template put them on disk. Outside it there is no template.
 *
 * The previous comment here — "a static build needs nothing added" — was true
 * of the sandbox and false of the world, which is exactly trap 4 (prompt-vs-
 * reality drift) in a new place.
 *
 * These are deliberately NOT copied from `template.ts`. Two reasons, and the
 * first is a bug waiting to happen: the template's `vite.config.ts` bakes
 * `server.proxy['/api'] → localhost:3001`, a DEV-SERVER feature that means
 * nothing on Vercel (trap 11) — shipping it would quietly suggest the API
 * works when it does not. And importing `template.ts` from `src/` drags in the
 * E2B SDK. So deployment owns its own build setup, tuned for Vercel.
 */
const DEPLOY_DEPENDENCIES: Record<string, string> = {
  react: "19.0.0",
  "react-dom": "19.0.0",
  "@tanstack/react-query": "^5.62.0",
  "lucide-react": "^0.460.0",
  "class-variance-authority": "^0.7.1",
  clsx: "^2.1.1",
  "tailwind-merge": "^2.5.4",
  "@supabase/supabase-js": "^2.45.0",
  "@radix-ui/react-dialog": "^1.1.2",
  "@radix-ui/react-dropdown-menu": "^2.1.2",
  "@radix-ui/react-label": "^2.1.0",
  "@radix-ui/react-select": "^2.1.2",
  "@radix-ui/react-separator": "^1.1.0",
  "@radix-ui/react-slot": "^1.1.0",
  "@radix-ui/react-tabs": "^2.1.1",
  "@radix-ui/react-toast": "^1.2.2",
  "@radix-ui/react-tooltip": "^1.1.3",
  "@radix-ui/react-avatar": "^1.1.1",
  "@radix-ui/react-checkbox": "^1.1.2",
  "@radix-ui/react-switch": "^1.1.1",
  hono: "^4.6.3",
  "@hono/node-server": "^1.13.1",
  zod: "^3.23.8",
};

const DEPLOY_DEV_DEPENDENCIES: Record<string, string> = {
  "@vitejs/plugin-react": "^4.3.1",
  vite: "^6.0.0",
  tailwindcss: "^4.0.0",
  "@tailwindcss/vite": "^4.0.0",
  typescript: "^5.5.4",
  "@types/react": "19.0.0",
  "@types/react-dom": "19.0.0",
};

/**
 * Dependencies the generated app declared for itself.
 *
 * A generated `package.json` is ignored by the sandbox for everything EXCEPT
 * its `dependencies` (CLAUDE.md, trap 2), which are installed. So an app that
 * imports `three` or `gsap` declared it there and will not build without it.
 * Dropping those on the way to Vercel would break exactly the richer apps.
 */
function declaredDependencies(files: Record<string, string>): Record<string, string> {
  const raw = files["package.json"];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const deps = (parsed as Record<string, unknown>)["dependencies"];
    if (typeof deps !== "object" || deps === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    // A generated package.json that does not parse is the model's error, not a
    // reason to fail the deploy — the baseline below still builds a React app.
    return {};
  }
}

function buildFiles(files: Record<string, string>): Record<string, string> {
  const pkg = {
    name: "lampcode-app",
    private: true,
    type: "module",
    scripts: { build: "vite build" },
    // The app's own declarations win: if it pinned a version, honour it.
    dependencies: { ...DEPLOY_DEPENDENCIES, ...declaredDependencies(files) },
    devDependencies: DEPLOY_DEV_DEPENDENCIES,
  };

  const buildFilesResult: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    // No `server.proxy` — see the note above. A production build has no dev
    // server, so a proxy here would be dead config that implies working API
    // calls. The generated app reaches its backend through
    // `import.meta.env.VITE_API_URL`, which is the contract the prompt already
    // teaches and `wiring.ts` already enforces.
    "vite.config.ts":
      `import { defineConfig } from 'vite'\n` +
      `import react from '@vitejs/plugin-react'\n` +
      `import tailwindcss from '@tailwindcss/vite'\n` +
      `import path from 'path'\n\n` +
      `export default defineConfig({\n` +
      `  plugins: [react(), tailwindcss()],\n` +
      `  resolve: { alias: { '@': path.resolve(__dirname, './src') } },\n` +
      `})\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          allowImportingTsExtensions: false,
          noEmit: true,
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    "index.html":
      `<!doctype html>\n<html lang="en">\n  <head>\n` +
      `    <meta charset="UTF-8" />\n` +
      `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
      `    <title>App</title>\n  </head>\n  <body>\n` +
      `    <div id="root"></div>\n` +
      `    <script type="module" src="/src/index.tsx"></script>\n` +
      `  </body>\n</html>\n`,
  };

  // These files live in the E2B image and therefore aren't guaranteed to be
  // in the persisted app file map sent to Vercel.
  for (const [relativePath, content] of Object.entries(PREBAKED_UI_PRIMITIVES)) {
    const path = `src/${relativePath}`;
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      buildFilesResult[path] = content;
    }
  }
  for (const [path, content] of [
    ["src/lib/utils.ts", UTILS_TS],
    ["src/lib/queryClient.ts", QUERY_CLIENT_TS],
    ["src/styles.css", STYLES_CSS],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      buildFilesResult[path] = content;
    }
  }
  return buildFilesResult;
}

const PYTHON_REQUIREMENT_FILES = ["requirements.txt", "src/server/requirements.txt"] as const;

function pythonPackageKey(value: string): string {
  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(value.trim())?.[1] ?? "";
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Parse the portable PEP 508 subset; never silently drop pip options or URLs. */
export function parsePythonRequirements(files: Record<string, string>): string[] {
  const result: string[] = [];
  for (const path of PYTHON_REQUIREMENT_FILES) {
    const content = files[path];
    if (typeof content !== "string") continue;
    for (const [index, raw] of content.split(/\r?\n/).entries()) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?)(.*)$/.exec(line);
      if (!match) {
        throw new Error("Unsupported Python requirement at " + path + ":" + (index + 1) +
          ". Automatic deploy supports package names with PEP 508 version constraints and markers, not pip directives, VCS/URL or local-path installs.");
      }
      const tail = (match[2] ?? "").trim();
      if (/[\\/@]/.test(tail) || tail.includes("://")) {
        throw new Error("Unsupported direct URL or local Python dependency at " + path + ":" + (index + 1) + ".");
      }
      const markerAt = tail.indexOf(";");
      const versionPart = (markerAt < 0 ? tail : tail.slice(0, markerAt)).trim();
      const markerPart = markerAt < 0 ? "" : tail.slice(markerAt + 1).trim();
      const validVersion = /^(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)(?:\s*,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*$/;
      const validMarker = /^[A-Za-z0-9_ ."'()!<>=:/-]+$/;
      if ((versionPart && !validVersion.test(versionPart)) ||
          (markerAt >= 0 && (!markerPart || !validMarker.test(markerPart)))) {
        throw new Error("Unsupported Python requirement syntax at " + path + ":" + (index + 1) + ".");
      }
      result.push(match[1] + (tail ? " " + tail : ""));
    }
  }
  const seen = new Set<string>();
  return result.filter((item) => {
    const key = item.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tomlArrayClose(text: string, open: number): number {
  let quote = "";
  let escaped = false;
  let comment = false;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "#") comment = true;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

function parseTomlStringArray(value: string): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error("Expected a TOML string array in pyproject.toml.");
  }
  const body = value.slice(1, -1);
  const values: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (/\s/.test(ch) || ch === ",") { i += 1; continue; }
    if (ch === "#") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (ch !== '"' && ch !== "'") {
      throw new Error("Unsupported non-string value in pyproject.toml dependency array.");
    }
    const quote = ch;
    const start = i++;
    let escaped = false;
    while (i < body.length) {
      const current = body[i] ?? "";
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && current === "\\") escaped = true;
      else if (current === quote) break;
      i += 1;
    }
    if (i >= body.length) throw new Error("Unterminated string in pyproject.toml dependency array.");
    const literal = body.slice(start, i + 1);
    if (quote === '"') {
      try { values.push(JSON.parse(literal) as string); }
      catch { throw new Error("Unsupported TOML string escape in pyproject.toml dependency array."); }
    } else {
      values.push(literal.slice(1, -1));
    }
    i += 1;
  }
  return values;
}

function projectSection(source: string): { start: number; end: number } | null {
  const lines = source.split("\n");
  const starts = lines.map((line, index) =>
    /^\s*\[project\]\s*(?:#.*)?$/.test(line) ? index : -1
  ).filter((index) => index >= 0);
  if (starts.length > 1) throw new Error("pyproject.toml contains duplicate [project] tables.");
  if (starts.length === 0) return null;
  const start = starts[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[i] ?? "")) { end = i; break; }
  }
  return { start, end };
}

function arrayAssignment(section: string, key: string): { open: number; close: number; values: string[] } | null {
  const match = new RegExp("^\\s*" + key + "\\s*=", "m").exec(section);
  if (!match) return null;
  const open = section.indexOf("[", match.index + match[0].length);
  const close = open >= 0 ? tomlArrayClose(section, open) : -1;
  if (open < 0 || close < 0) {
    throw new Error("pyproject.toml has an unsupported " + key + " value; refusing to overwrite project metadata.");
  }
  return { open, close, values: parseTomlStringArray(section.slice(open, close + 1)) };
}

function withFastApiProjectDependencies(existing: string, requirements: string[]): string {
  let source = existing.replace(/\r\n/g, "\n");
  if (!projectSection(source)) {
    const trimmed = source.trimEnd();
    source = (trimmed ? trimmed + "\n\n" : "") + '[project]\nname = "lampcode-generated-api"\n';
  }

  let bounds = projectSection(source)!;
  let sectionOffset = source.split("\n").slice(0, bounds.start + 1).join("\n").length + 1;
  let section = source.split("\n").slice(bounds.start + 1, bounds.end).join("\n");
  if (!/^\s*name\s*=/m.test(section)) {
    source = source.slice(0, sectionOffset) + 'name = "lampcode-generated-api"\n' + source.slice(sectionOffset);
    bounds = projectSection(source)!;
    sectionOffset = source.split("\n").slice(0, bounds.start + 1).join("\n").length + 1;
    section = source.split("\n").slice(bounds.start + 1, bounds.end).join("\n");
  }

  const dynamic = arrayAssignment(section, "dynamic");
  if (dynamic?.values.includes("dependencies")) {
    throw new Error("pyproject.toml declares dependencies as dynamic; automatic deploy cannot safely merge requirements.txt.");
  }

  const dependency = arrayAssignment(section, "dependencies");
  const merged = dependency?.values.slice() ?? [];
  const seen = new Set(merged.map(pythonPackageKey).filter(Boolean));
  for (const item of requirements) {
    const key = pythonPackageKey(item);
    if (key && !seen.has(key)) { merged.push(item); seen.add(key); }
  }
  if (!seen.has("fastapi")) merged.push("fastapi");

  const replacement = "[\n" + merged.map((item) => "  " + JSON.stringify(item) + ",").join("\n") + "\n]";
  if (dependency) {
    const open = sectionOffset + dependency.open;
    const close = sectionOffset + dependency.close;
    source = source.slice(0, open) + replacement + source.slice(close + 1);
  } else {
    const lines = source.split("\n");
    bounds = projectSection(source)!;
    const insertAt = lines.slice(0, bounds.end).join("\n").length;
    const prefix = source.slice(0, insertAt);
    const separator = prefix.endsWith("\n") ? "" : "\n";
    source = prefix + separator + "dependencies = " + replacement + "\n" + source.slice(insertAt);
  }
  return source + (existing.endsWith("\n") && !source.endsWith("\n") ? "\n" : "");
}

function withFastApiVercelEntrypoint(existing: string, requirements: string[] = []): string {
  const metadata = withFastApiProjectDependencies(existing, requirements);
  const lines = metadata.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\[tool\.vercel\]\s*(?:#.*)?$/.test(line));
  if (headerIndex >= 0) {
    let sectionEnd = lines.length;
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[i] ?? "")) { sectionEnd = i; break; }
    }
    if (lines.slice(headerIndex + 1, sectionEnd).some((line) => /^\s*entrypoint\s*=/.test(line))) return metadata;
    lines.splice(headerIndex + 1, 0, 'entrypoint = "src.server.main:app"');
    return lines.join("\n") + (metadata.endsWith("\n") ? "\n" : "");
  }
  const trimmed = metadata.trimEnd();
  return trimmed + (trimmed ? "\n\n" : "") + '[tool.vercel]\nentrypoint = "src.server.main:app"\n';
}

function fastApiEntrypoint(pyproject: string): string {
  const lines = pyproject.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*\[tool\.vercel\]\s*(?:#.*)?$/.test(line));
  if (header < 0) return "src.server.main:app";
  for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i] ?? ""); i += 1) {
    const found = /^\s*entrypoint\s*=\s*["']([^"']+)["']/.exec(lines[i] ?? "");
    if (found?.[1]) return found[1];
  }
  return "src.server.main:app";
}

function isPythonRequirementFile(path: string): boolean {
  return (PYTHON_REQUIREMENT_FILES as readonly string[]).includes(path);
}

function isPythonBackendFile(path: string): boolean {
  return path.endsWith(".py") || path.startsWith("src/server/") ||
    path.startsWith("src/db/") || path.startsWith("alembic/") ||
    path === "alembic.ini" || path.endsWith(".sql") ||
    /\.(?:toml|ini|ya?ml|csv)$/i.test(path);
}

function servicesVercelConfig(existing: string | undefined, backendEntrypoint: string): string {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("vercel.json must contain a JSON object.");
      }
      config = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error("Cannot add Vercel Services to the existing vercel.json: " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  const currentServices = config["services"];
  if (currentServices !== undefined &&
      (typeof currentServices !== "object" || currentServices === null || Array.isArray(currentServices))) {
    throw new Error("Existing vercel.json services must be an object.");
  }
  const services = (currentServices ?? {}) as Record<string, unknown>;
  if ("lampcode_frontend" in services || "lampcode_backend" in services) {
    throw new Error("Existing vercel.json already uses a reserved LampCode service name; refusing to overwrite it.");
  }
  if ("functions" in config) {
    throw new Error("Existing vercel.json has global functions settings. Move these into the intended service before automatic multi-service deployment.");
  }

  const frontend: Record<string, unknown> = { root: "frontend", framework: "vite" };
  const backend: Record<string, unknown> = { root: "backend", entrypoint: backendEntrypoint, framework: "fastapi" };
  for (const key of ["buildCommand", "installCommand", "outputDirectory", "devCommand", "ignoreCommand", "framework"]) {
    if (config[key] !== undefined) { frontend[key] = config[key]; delete config[key]; }
  }
  const previousRewrites = config["rewrites"];
  if (previousRewrites !== undefined && !Array.isArray(previousRewrites)) {
    throw new Error("Existing vercel.json rewrites must be an array.");
  }
  return JSON.stringify({
    ...config,
    services: { ...services, lampcode_frontend: frontend, lampcode_backend: backend },
    rewrites: [
      { source: "/api", destination: { service: "lampcode_backend" } },
      { source: "/api/(.*)", destination: { service: "lampcode_backend" } },
      ...(previousRewrites as unknown[] | undefined ?? []),
      { source: "/(.*)", destination: { service: "lampcode_frontend" } },
    ],
  }, null, 2) + "\n";
}

function viteFastApiScaffold(files: Record<string, string>): Record<string, string> {
  if (files["vercel.toml"]) {
    throw new Error("This app already has vercel.toml. Automatic Vite + FastAPI deployment requires a vercel.json Services config; convert the existing config first.");
  }
  const out: Record<string, string> = {};
  const frontendFiles = buildFiles(files);
  for (const [path, content] of Object.entries(files)) {
    if (path === "package.json" || path === "vercel.json" ||
        path === "pyproject.toml" || isPythonRequirementFile(path) || isPythonBackendFile(path)) continue;
    out["frontend/" + path] = content;
  }
  for (const [path, content] of Object.entries(frontendFiles)) out["frontend/" + path] = content;
  for (const [path, content] of Object.entries(files)) {
    if (isPythonBackendFile(path)) out["backend/" + path] = content;
  }
  const pyproject = withFastApiVercelEntrypoint(
    files["pyproject.toml"] ?? "",
    parsePythonRequirements(files),
  );
  out["backend/pyproject.toml"] = pyproject;
  out["vercel.json"] = servicesVercelConfig(files["vercel.json"], fastApiEntrypoint(pyproject));
  return out;
}

export function vercelScaffold(
  shape: DeployShape,
  files: Record<string, string> = {},
): Record<string, string> {
  if (shape === "nextjs") return nextjsVercelScaffold(files);
  if (shape === "vite-fastapi") return viteFastApiScaffold(files);
  if (shape === "hono") {
    return {
      ...buildFiles(files),
      // A catch-all so every /api/* path reaches the one exported app, which
      // then routes internally — the app already does `app.route('/api', api)`.
      // `export default app` works because a Hono instance exposes `.fetch`,
      // which is exactly the shape Vercel's api/ functions expect. No adapter,
      // so nothing here depends on the deprecated `hono/vercel`.
      "api/[...route].ts":
        `// Added by Lampcode at deploy time. The app itself is in src/server/app.ts\n` +
        `// and knows nothing about Vercel; src/server/index.ts still starts it locally.\n` +
        `import app from "../src/server/app.js";\n` +
        `export default app;\n`,
    };
  }
  // The Python preset can detect a root-level FastAPI app, but LampCode keeps
  // the generated entrypoint at src/server/main.py. Vercel's live build rejects
  // that nested path unless the custom entrypoint is declared in pyproject.toml.
  // Preserve any app-owned Python project metadata and only add the missing
  // Vercel entrypoint setting.
  if (shape === "fastapi") {
    return {
      "pyproject.toml": withFastApiVercelEntrypoint(files["pyproject.toml"] ?? "", parsePythonRequirements(files)),
    };
  }

  // Static: a React/Vite app, which needs everything above to build.
  return buildFiles(files);
}

/** A project name Vercel accepts: lowercase, dashes, no leading/trailing dash. */
export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
    .replace(/-+$/g, "");
  return slug === "" ? "lampcode-app" : slug;
}

/** Paths that must never be uploaded: build output, dependencies, local state. */
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.git|\.vercel|coverage)(\/|$)|(^|\/)\.env(\.|$)/;

/** Vercel accepts far more than this; the cap is here so one runaway generated
 *  file cannot turn a deploy into a multi-megabyte request. */
const MAX_TOTAL_BYTES = 8_000_000;

export interface InlinedFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

/**
 * The generated files in the shape `create_deployment` takes inline.
 *
 * Inline rather than the separate upload endpoint because these are source
 * files, not assets: a whole generated app is tens of kilobytes, and one call
 * beats one upload per file plus a SHA1 for each.
 */
export function toInlinedFiles(files: Record<string, string>): {
  inlined: InlinedFile[];
  skipped: string[];
} {
  const inlined: InlinedFile[] = [];
  const skipped: string[] = [];
  let budget = MAX_TOTAL_BYTES;
  // Sorted so a deploy is reproducible and so the skipped list is stable when
  // the budget runs out, rather than depending on object key order.
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (typeof content !== "string") continue;
    if (SKIP_RE.test(path)) {
      skipped.push(path);
      continue;
    }
    const size = Buffer.byteLength(content, "utf8");
    if (size > budget) {
      skipped.push(path);
      continue;
    }
    budget -= size;
    inlined.push({ file: path, data: content, encoding: "utf-8" });
  }
  return { inlined, skipped };
}

/** The first JSON object or array in an MCP text result. MCP tools answer with
 *  text, and Vercel's wrap their JSON in prose often enough that indexOf on the
 *  first brace is the reliable read. */
export function parseMcpJson(text: string): Record<string, unknown> | null {
  for (const open of ["{", "["]) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    const close = text.lastIndexOf(open === "{" ? "}" : "]");
    if (close <= start) continue;
    try {
      const v: unknown = JSON.parse(text.slice(start, close + 1));
      if (v !== null && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      // fall through to the next shape
    }
  }
  return null;
}

/**
 * The object the deployment fields actually live on.
 *
 * Vercel's MCP server wraps its payload — the real shape, logged from a live
 * call on 2026-10-16, is `{ result: { deployment: { id, url, state, … } } }`,
 * not a bare deployment object. Reading only the top level found no `id`, so
 * every successful create was reported as "Vercel accepted the request but
 * returned no deployment to follow" while the deployment was sitting one and
 * two levels down, already INITIALIZING.
 *
 * Both levels are unwrapped and the outermost is kept as a fallback, because
 * the REST API returns the bare shape and a future MCP version may stop
 * wrapping. Reading a field that is present at either depth costs nothing;
 * assuming one depth cost a working deploy.
 */
function deploymentOf(o: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!o) return null;
  const result = o["result"];
  const inner = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : o;
  const dep = inner["deployment"];
  if (dep !== null && typeof dep === "object") return dep as Record<string, unknown>;
  return inner;
}

function str(o: Record<string, unknown> | null, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Vercel's terminal deployment states. */
const DONE_STATES = new Set(["READY", "ERROR", "CANCELED", "DELETED"]);

export interface DeployInput {
  auth: VercelAuth;
  /** The app's files, exactly as delivered — scaffold is added here, not by the caller. */
  files: Record<string, string>;
  /** What the user called their project. */
  projectName: string;
  /** Poll ceiling. A Vite build is usually under a minute; this is the give-up point. */
  maxWaitMs?: number;
  /** Injected in tests. */
  call?: typeof callMcpTool;
  smoke?: typeof runSmokeTests;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Create the deployment, wait for it, then prove the URL actually answers.
 *
 * The smoke step is not decoration. `create_deployment` returning a URL proves
 * the API call was accepted; it says nothing about whether the app loads or
 * whether `/api/*` reached the function — and the routing assumption in
 * `vercelScaffold` is the one thing here nobody has tested. So the outcome is
 * `ok` only when Vercel says READY **and** the URL answers.
 */
export async function deployToVercel(input: DeployInput): Promise<DeployOutcome> {
  const call = input.call ?? callMcpTool;
  const smokeFn = input.smoke ?? runSmokeTests;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxWaitMs = input.maxWaitMs ?? 240_000;

  const shape = detectDeployShape(input.files);

  // Checked on the APP's files, before the scaffold is added. Once the scaffold
  // always contributes a package.json and an index.html, "did we get anything
  // to deploy" can never be answered from the combined set — it would always
  // be yes, and an empty project would ship a blank React shell as though that
  // were the app. Caught by a case that was already here.
  const { inlined: appFiles } = toInlinedFiles(input.files);
  if (appFiles.length === 0) {
    return { ok: false, shape, error: "There are no files to deploy." };
  }

  let withScaffold: Record<string, string>;
  try {
    const scaffold = vercelScaffold(shape, input.files);
    withScaffold = shape === "vite-fastapi" ? scaffold : { ...input.files, ...scaffold };
    if (shape === "fastapi") {
      for (const path of PYTHON_REQUIREMENT_FILES) delete withScaffold[path];
    }
  } catch (error) {
    return {
      ok: false,
      shape,
      error: "Cannot prepare the Python deployment safely: " + (error instanceof Error ? error.message : String(error)),
    };
  }
  const { inlined, skipped } = toInlinedFiles(withScaffold);
  const name = projectSlug(input.projectName);

  const target = (mcpToolName: string) => ({
    serverSlug: "vercel",
    serverUrl: VERCEL_MCP_URL,
    authToken: input.auth.accessToken,
    mcpToolName,
  });

  const framework = shape === "vite-fastapi" ? "services" : shape === "fastapi" ? "fastapi" : shape === "nextjs" ? "nextjs" : "vite";
  const requestBody: Record<string, unknown> = {
    name,
    target: "production",
    files: inlined,
    projectSettings: { framework },
    ...(input.auth.teamId ? { teamId: input.auth.teamId } : {}),
  };

  logger.info(
    { project: name, shape, framework, files: inlined.length, skipped: skipped.length },
    "Deploying to the user's Vercel",
  );

  let created: string;
  try {
    created = await call(target("create_deployment"), {
      requestBody,
      // Without this Vercel returns 400 asking a human to confirm whenever the
      // framework it detects differs from the one sent — which no automated
      // deploy can answer.
      skipAutoDetectionConfirmation: "1",
      ...(input.auth.teamId ? { teamId: input.auth.teamId } : {}),
    });
  } catch (err) {
    logger.warn({ project: name, err }, "Vercel create_deployment failed");
    return {
      ok: false,
      shape,
      error: `Vercel refused the deployment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const createdJson = deploymentOf(parseMcpJson(created));
  const id = str(createdJson, "id") ?? str(createdJson, "uid");
  let url = str(createdJson, "url");
  if (id === undefined && url === undefined) {
    // Say what Vercel ACTUALLY returned. The first real run of this function,
    // 2026-10-16, failed here and the message was all anyone got: no id, no
    // error, no clue. The model then guessed the connection needed
    // re-authorising, which was wrong, and a human had to read the sandbox to
    // find the real cause. A diagnostic that discards the diagnosis is the
    // same failure as a gate that passes having examined nothing.
    logger.warn({ project: name, response: created.slice(0, 600) }, "Vercel returned no deployment id");
    return {
      ok: false,
      shape,
      error:
        `Vercel accepted the request but returned no deployment to follow. ` +
        `What it sent back: ${created.slice(0, 400)}`,
    };
  }

  // ── Wait for the build ────────────────────────────────────────────────────
  // Polled rather than assumed ready: a Vite build takes time, and smoke-testing
  // a URL that is still building reports a failure that is only a race.
  let state: string | undefined;
  const startedMs = Date.now();
  let waitMs = 3_000;
  while (Date.now() - startedMs < maxWaitMs) {
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 1.5, 15_000);
    try {
      const got = await call(target("get_deployment"), {
        idOrUrl: id ?? (url as string),
        ...(input.auth.teamId ? { teamId: input.auth.teamId } : {}),
      });
      // Same wrapping as create_deployment — see deploymentOf. Polling the
      // top level here would have left `state` undefined forever, so the loop
      // would have run to its ceiling on a deployment that was already READY.
      const j = deploymentOf(parseMcpJson(got));
      state = str(j, "readyState") ?? str(j, "state") ?? state;
      url = str(j, "url") ?? url;
      if (state !== undefined && DONE_STATES.has(state)) break;
    } catch (err) {
      // A transient read failure is not a failed deploy — keep polling until the
      // ceiling, and report the state we last saw.
      logger.warn({ project: name, err }, "Vercel get_deployment read failed — retrying");
    }
  }

  if (state !== "READY") {
    // A non-terminal state at the ceiling means the build is STILL RUNNING, not
    // that it failed — "finished with state BUILDING" is a contradiction, and it
    // would have told a user their slow build had broken. Only a terminal state
    // is a verdict.
    const stillRunning = state === undefined || !DONE_STATES.has(state);
    return {
      ok: false,
      shape,
      ...(url === undefined ? {} : { url }),
      ...(state === undefined ? {} : { state }),
      error: stillRunning
        ? "The deployment did not finish in time. It may still be building on Vercel."
        : `Vercel finished with state ${state}.`,
    };
  }

  if (url === undefined) {
    return { ok: false, shape, state, error: "Vercel reported READY but gave no URL." };
  }

  // Vercel returns a bare hostname.
  const fullUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
  let smoke: Awaited<ReturnType<typeof runSmokeTests>> | undefined;
  let smokeError: string | undefined;
  try {
    smoke = await smokeFn(
      fullUrl,
      undefined,
      deploySmokeTargets(shape, input.files),
    );
  } catch (err) {
    // A failed verifier is not evidence that the app works. Keep the live URL
    // visible to the user, but never turn an exception into a green deploy.
    logger.warn({ project: name, err }, "Post-deploy smoke verification failed");
    smokeError = "The deployment reached READY, but LampCode could not complete the post-deploy verification.";
  }

  if (smoke?.ok !== true) {
    return {
      ok: false,
      url: fullUrl,
      state,
      shape,
      ...(smoke === undefined ? {} : { smoke }),
      error: smokeError ?? "The app deployed but did not answer correctly when checked.",
    };
  }

  return { ok: true, url: fullUrl, state, shape, smoke };
}

/**
 * What to tell the user. Their language, no provider jargon beyond the name of
 * the service they themselves connected.
 *
 * The failure lines matter more than the success one. A deploy that half-works
 * is the case every other builder reports as done, and the routing assumption
 * in `vercelScaffold` is exactly the kind of thing that produces a live URL
 * serving a broken app.
 */
export function formatDeployForUser(outcome: DeployOutcome): string[] {
  if (outcome.ok && outcome.url) {
    return [`It's live on your Vercel: ${outcome.url}`];
  }
  if (outcome.url && outcome.smoke?.ok === false) {
    const failed = outcome.smoke.checks.filter((c) => !c.passed).map((c) => c.name);
    return [
      `It deployed to ${outcome.url}, but it isn't answering properly yet.`,
      failed.length > 0 ? `What didn't respond: ${failed.join(", ")}.` : "",
      "The build succeeded, so this is about how the deployed app is wired rather than the code itself. Tell me and I'll look.",
    ].filter((l) => l !== "");
  }
  if (outcome.url && outcome.state === "READY" && outcome.error) {
    return [
      `Vercel created the deployment at ${outcome.url}, but LampCode could not verify it.`,
      outcome.error,
      "Do not treat this as a verified successful deploy until the live URL has been checked.",
    ];
  }
  return [
    outcome.error ?? "The deployment didn't go through.",
    "Nothing was changed in your project. Tell me and I'll try again.",
  ];
}
