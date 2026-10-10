import { Sandbox, CommandExitError } from "e2b";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { createRedis } from "../lib/redis.js";
import { downloadProjectFiles } from "../storage/project-files.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projectEnvVars } from "../db/schema.js";
import { decrypt } from "../server/env-crypto.js";
import type { FullstackFramework } from "../agents/prompt-builder.js";

/**
 * E2B cloud sandbox preview for fullstack builds.
 *
 * Unlike the in-browser WebContainer/Sandpack preview (JS/TS only), E2B runs a
 * real Linux VM, so it can host backends in any language the LLM generates
 * (Node, Python, Go, etc). Sandboxes are kept alive per project (not per build
 * session) and reused across follow-up builds via E2B's pause/resume — the
 * Lovable pattern — so we avoid paying the npm-install + cold-start cost on
 * every single prompt.
 */

export type PreviewLogCallback = (line: string) => void;

const PROJECT_DIR = "/home/user/app";
// Internal tooling, with its own node_modules holding playwright (template.ts).
// Any script that imports from it MUST be written INTO this directory: Node
// resolves a bare specifier like "playwright" relative to the importing FILE,
// not the process working directory, so a script left in /tmp fails with
// ERR_MODULE_NOT_FOUND however we cd beforehand. Verified — it is why
// fetch_reference and the preview thumbnail never once worked.
const TOOLS_DIR = "/home/user/.lampcode-tools";
// Where the template installed Chromium. playwright otherwise resolves it from
// the running user's home, and the image is built as root but run as `user`, so
// the default lands the binary somewhere the sandbox cannot see. template.ts
// sets the same value as a Docker ENV; prefixing it on the command too means
// this does not depend on that ENV surviving into E2B's runtime.
const TOOLS_ENV = `PLAYWRIGHT_BROWSERS_PATH=${TOOLS_DIR}/browsers`;
// Sandbox lifetime per session. Set on create AND resume, and refreshed every
// build turn (heartbeat). Generous so an active testing session never expires
// mid-use; idle sandboxes are paused on WS disconnect well before this.
const SANDBOX_TIMEOUT_MS = Number(process.env["SANDBOX_RUN_TIMEOUT_MS"] ?? 60 * 60 * 1000); // 1 hour

// Custom template that pre-installs Node, frontend deps, and a baseline
// Vite/React scaffold.
//
// Defined in `e2b-template/template.ts` and built by `e2b-template/build.ts`
// via Template.build(). NOT by either e2b.Dockerfile — both are orphans, and
// this comment used to point at them, which is the trap it now warns about:
// editing a Dockerfile here has no effect on the live image.
//
// Railway Env Var: E2B_TEMPLATE_ID=lampcode-vite
const TEMPLATE_ID = process.env["E2B_TEMPLATE_ID"] ?? "lampcode-vite";

/**
 * Returns the E2B sandbox template ID for the given fullstack framework.
 *
 * It ALWAYS returns the React/Vite template, and deliberately ignores
 * NEXTJS_TEMPLATE_ID / TANSTACK_TEMPLATE_ID even when they are set — which on
 * Railway they are, as of 2026-10-10.
 *
 * The reason is the opposite of what it looks like. `lampcode-nextjs` and
 * `lampcode-tanstack` are REAL templates on the E2B account (15 and 13 builds)
 * and they boot fine, which is exactly what makes routing to them dangerous
 * rather than merely broken. Both were last built on 2026-09-09, before every
 * October fix, and `template-nextjs.ts` contains NONE of `.lampcode-tools`,
 * playwright, `check-render.mjs`, `PLAYWRIGHT_BROWSERS_PATH` or vitest — the
 * live `template.ts` has all five. A build routed there loses `check_page`,
 * `check_types` AND `run_tests` in one step, silently: the sandbox comes up,
 * the app renders, and all three gates report `unavailable` with nothing
 * anywhere saying why. A template that fails to boot is loud; this is not.
 *
 * It is also very unlikely such a build is genuinely Next.js. `classifyBuild`
 * pins `framework` to "react" for new builds, so the only route to another
 * value is `detectFrameworkFromFiles` on an EDIT — and the project it is
 * inspecting was itself produced on this Vite template, so an `app/layout.tsx`
 * in it is a stray file rather than a Next.js app. Returning the Vite template
 * is therefore the correct answer for that project, not just the safe one.
 *
 * To re-enable: port the October fixes into `template-nextjs.ts` (tools dir,
 * playwright + browser path, check-render.mjs, vitest and its config), rebuild,
 * verify in a live sandbox the way `e2b-template/verify-template.ts` does, and
 * only then read the env vars here again.
 */
export function selectTemplate(framework: FullstackFramework): string {
  if (framework === "nextjs" || framework === "tanstack") {
    const configured = process.env[
      framework === "nextjs" ? "NEXTJS_TEMPLATE_ID" : "TANSTACK_TEMPLATE_ID"
    ];
    if (configured) {
      console.warn(
        `[e2b] ${framework} template id is configured (${configured}) but IGNORED — ` +
        `that image predates the October fixes and has no check_page/check_types/run_tests. ` +
        `Using ${TEMPLATE_ID}. See selectTemplate() for how to re-enable.`,
      );
    }
    return TEMPLATE_ID;
  }
  return TEMPLATE_ID;
}

// E2B sandbox snapshots (created on pause) expire after 30 days. We key the
// Redis record's TTL slightly below that — 25 days — so we never hand back a
// sandboxId whose underlying snapshot has already been garbage-collected.
const SANDBOX_REDIS_TTL_SECONDS = 25 * 24 * 60 * 60;

const READY_POLL_INTERVAL_MS = 2_000;

/** Next.js/TanStack `next dev`/`vinxi dev` cold-compiles on first start (45–90 s). React/Vite is much faster (< 30 s). */
function readyPollTimeoutMs(framework: FullstackFramework): number {
  return framework === "nextjs" || framework === "tanstack" ? 90_000 : 30_000;
}

const redis = createRedis();

// Redis is only a CACHE of projectId → sandboxId here, never the source of
// truth. But createRedis() sets maxRetriesPerRequest: null, which makes ioredis
// queue commands indefinitely while the connection is down rather than failing
// them — the same trap rate-limit.ts guards against. Unbounded, the redis.get()
// on acquireRunningSandbox()'s first line hung the entire preview path forever
// with no error and no log (confirmed against live Railway logs, where this
// deployment reconnects constantly). Bounded, a Redis blip degrades to "no
// cached sandbox" and we cold-start instead.
const REDIS_TIMEOUT_MS = 2_000;

class RedisTimeoutError extends Error {}

function withRedisTimeout<T>(promise: Promise<T>, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RedisTimeoutError(`redis ${op} exceeded ${REDIS_TIMEOUT_MS}ms`)),
      REDIS_TIMEOUT_MS,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err as Error); },
    );
  });
}

function redisKey(projectId: string): string {
  return `e2b:sandbox:${projectId}`;
}

function frameworkRedisKey(projectId: string): string {
  return `e2b:framework:${projectId}`;
}

// Live Sandbox object references for the current process lifetime — needed so
// follow-up builds in the same process can write files directly without a
// network round-trip to resume. Lost on restart; Redis is the durable record.
const sandboxes = new Map<string, Sandbox>();
// Tracks which fullstack framework each live sandbox was created for, so
// framework-aware helpers (port/start-command) work without extra parameters
// at call sites that only have a projectId (resume-on-open, follow-up writes).
const sandboxFrameworks = new Map<string, FullstackFramework>();

/** Port the dev server listens on inside the sandbox. */
function devPort(framework: FullstackFramework): number {
  return framework === "nextjs" || framework === "tanstack" ? 3000 : 5173;
}

/** Shell command that starts the dev server. */
function devStartCommand(framework: FullstackFramework): string {
  switch (framework) {
    case "nextjs":
    case "tanstack":
      // package.json `dev` script already includes --port 3000 / --hostname 0.0.0.0
      return "npm run dev";
    default:
      return "npx vite --host 0.0.0.0 --port 5173";
  }
}

/** Process name pattern used to kill a stale dev-server before restarting. */
function devKillPattern(framework: FullstackFramework): string {
  return framework === "nextjs" ? "next" : framework === "tanstack" ? "vinxi" : "vite";
}

// Per-project preview Supabase override (the project owner's OWN connected
// Supabase). Set at build start; used by writePreviewEnv before Vite boots.
const projectPreviewEnv = new Map<string, { url: string; anonKey: string; serviceKey?: string }>();

/** Point a project's preview at the owner's connected Supabase (anon key only). */
export function setProjectPreviewEnv(
  projectId: string,
  creds: { url: string; anonKey: string; serviceKey?: string } | null,
): void {
  if (creds) projectPreviewEnv.set(projectId, creds);
  else projectPreviewEnv.delete(projectId);
}

// In-flight pre-warm promises, keyed by projectId. When a build starts we kick
// off sandbox boot in the background (parallel with AI generation); the
// preview-write path awaits this so it never races into creating a second
// sandbox for the same project.
const warmingSandboxes = new Map<string, Promise<Sandbox>>();

/**
 * Polls the preview URL until it responds or the timeout elapses. The dev
 * server is started in the background with no readiness signal, so without
 * this we'd hand the user a URL that may still be 404ing/connection-refused.
 * Any HTTP response (even an error status) means the server is up and routing.
 */
async function waitForServerReady(url: string, framework: FullstackFramework): Promise<boolean> {
  const deadline = Date.now() + readyPollTimeoutMs(framework);
  while (Date.now() < deadline) {
    try {
      // The deadline above is only re-checked between iterations, so an
      // unbounded fetch here would hang this loop (and the whole sandbox
      // acquisition) indefinitely — E2B's edge can accept the connection for a
      // still-booting sandbox and then never respond. Same 3s bound the
      // ensureDevServer probe already uses; a timeout just means "not ready
      // yet", which the catch below already handles as keep-polling.
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // Connection refused / not yet listening / probe timed out — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

const VITE_CONFIG_FILENAMES = ["vite.config.ts", "vite.config.js"];

// Injected into the generated vite.config.ts server block so the E2B preview
// works end to end:
//  - allowedHosts: Vite 5+ rejects requests from hosts it doesn't recognize,
//    but E2B serves the preview from a dynamic `*.e2b.app` subdomain.
//  - hmr.clientPort 443 + protocol wss: the preview iframe loads over HTTPS,
//    but Vite otherwise advertises `ws://localhost:5173` for HMR — the browser
//    can't reach that, so live-reload silently dies. Pinning the client to the
//    public HTTPS port makes HMR connect back through E2B's TLS endpoint.
const HMR_SNIPPET = "hmr: { clientPort: 443, protocol: 'wss' },";
const ALLOWED_HOSTS_SNIPPET = "allowedHosts: true,";

/**
 * Forces the generated vite.config.ts to be E2B-preview-safe. The LLM doesn't
 * reliably emit `allowedHosts`/`hmr` (it often writes a custom `server: {}`
 * block with just a proxy), so every write is patched in-place here, injecting
 * only the pieces that are missing and preserving everything else the LLM set.
 */
/**
 * Guarantee the app's entry point still loads the stylesheet.
 *
 * The template bakes an `src/index.tsx` that imports `./styles.css`, which is
 * where every Tailwind class and design token comes from. But `src/index.tsx`
 * is deliberately NOT in BAKED_FILES — the model has to be able to wrap the app
 * in providers (QueryClientProvider, AuthProvider, a router). So it rewrites
 * that file, and when its version omits the stylesheet import the whole app
 * renders completely unstyled: bare text stacked down the page, no layout.
 *
 * Adding it to BAKED_FILES would fix the styling and break the providers. So
 * the import is re-inserted instead, leaving everything else the model wrote
 * untouched. Same shape as patchViteConfig above: repair the generated file
 * rather than forbid it.
 */
function patchEntryStylesheet(files: Record<string, string>, log: PreviewLogCallback): void {
  for (const filename of ["src/index.tsx", "src/main.tsx", "src/index.jsx", "src/main.jsx"]) {
    const content = files[filename];
    if (content === undefined) continue;
    // Any form of the stylesheet import counts — './styles.css', 'src/styles.css',
    // or a different sheet the model brought itself.
    if (/import\s+['"][^'"]*\.css['"]/.test(content)) return;

    const lines = content.split("\n");
    // Place it after the last top-level import so it can't land above a
    // directive like "use client" or inside a comment block.
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i] ?? "")) lastImport = i;
    }
    const importLine = "import './styles.css'";
    lines.splice(lastImport + 1, 0, importLine);
    files[filename] = lines.join("\n");
    log(`Re-added the stylesheet import to ${filename} — without it the app renders unstyled`);
    logger.warn({ filename }, "[e2b] generated entry point dropped the stylesheet import — re-added");
    return;
  }
}

function patchViteConfig(files: Record<string, string>, log: PreviewLogCallback): void {
  for (const filename of VITE_CONFIG_FILENAMES) {
    const content = files[filename];
    if (content === undefined) continue;

    const needsAllowedHosts = !/allowedHosts/.test(content);
    const needsHmr = !/\bhmr\s*:/.test(content);
    if (!needsAllowedHosts && !needsHmr) return;

    const additions = [
      needsAllowedHosts ? ALLOWED_HOSTS_SNIPPET : null,
      needsHmr ? HMR_SNIPPET : null,
    ].filter(Boolean);

    let patched: string;
    if (/server\s*:\s*\{/.test(content)) {
      patched = content.replace(
        /server\s*:\s*\{/,
        (m) => `${m}\n    ${additions.join("\n    ")}`,
      );
    } else if (/defineConfig\(\s*\{/.test(content)) {
      patched = content.replace(
        /defineConfig\(\s*\{/,
        (m) => `${m}\n  server: { ${additions.join(" ")} },`,
      );
    } else {
      continue;
    }

    log(`Patched ${filename} for E2B preview (${additions.length} setting(s) injected)`);
    files[filename] = patched;
    return;
  }
}

// The preview template already ships known-good versions of these files (with
// the right Vite host/allowedHosts/HMR config and pre-installed node_modules).
// Overwriting them with LLM-generated copies is what broke the preview: a bad
// vite.config restarts/crashes Vite, and a different package.json triggers a
// runtime `npm install` that disrupts the already-running dev server ("no
// service on port 5173"). So we never write these into the sandbox — the model
// only contributes src/** app files on top of the baked baseline.
const BAKED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lockb",
  // React/Vite template config — must not be overwritten (allowedHosts/HMR would break)
  "vite.config.ts",
  "vite.config.js",
  "tsconfig.json",
  "tsconfig.node.json",
  "index.html",
  // Vitest config + its jest-dom setup file. The model writes test files, not
  // the harness they run in: a rewritten vitest.config.ts loses the jsdom
  // environment and the @ alias, and every component test then fails on
  // something that has nothing to do with the code under test.
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.setup.ts",
  // Next.js template config
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  // TanStack Start / Vinxi config (controls server port — must stay as baked)
  "app.config.ts",
  // The model emits an empty .env; we write the real one (with the preview
  // Supabase creds) ourselves, before the dev server starts, in writePreviewEnv().
  ".env",
  ".env.example",
  // Foundation utility files — the LLM imports these but must not overwrite them.
  "src/lib/utils.ts",
  "src/lib/queryClient.ts",
  // Tailwind v4 design token stylesheet — the LLM generates v3 syntax (@tailwind base)
  // which breaks the @tailwindcss/vite v4 plugin. Baked file has correct v4 CSS.
  "src/styles.css",
  // Next.js equivalent (root-level lib, no src/ prefix)
  "lib/utils.ts",
  "lib/queryClient.ts",
]);

/**
 * A project's own environment variables, decrypted.
 *
 * Values are AES-256-GCM at rest (see env-crypto). A row that cannot be
 * decrypted is skipped rather than failing the whole preview: one unreadable
 * variable should not cost the app the rest of its configuration.
 */
async function loadProjectEnvVars(projectId: string): Promise<{ key: string; value: string }[]> {
  try {
    const rows = await db
      .select({
        key: projectEnvVars.key,
        environment: projectEnvVars.environment,
        encryptedValue: projectEnvVars.encryptedValue,
        iv: projectEnvVars.iv,
        tag: projectEnvVars.tag,
      })
      .from(projectEnvVars)
      .where(eq(projectEnvVars.projectId, projectId));

    // The same key may exist per environment — the unique index is on
    // (projectId, environment, key) — so a project can hold three values for
    // one name. The preview runs the app as it would run live, so production
    // wins, then staging, then development. Without an explicit order this
    // came down to whichever row the database returned last.
    const RANK: Record<string, number> = { production: 3, staging: 2, development: 1 };
    const best = new Map<string, { rank: number; value: string }>();
    for (const row of rows) {
      let value: string;
      try {
        value = decrypt({ encrypted: row.encryptedValue, iv: row.iv, tag: row.tag });
      } catch (err) {
        logger.warn({ projectId, key: row.key, err }, "[e2b] could not decrypt a project variable");
        continue;
      }
      const rank = RANK[row.environment] ?? 0;
      const held = best.get(row.key);
      if (!held || rank > held.rank) best.set(row.key, { rank, value });
    }
    return [...best.entries()].map(([key, { value }]) => ({ key, value }));
  } catch (err) {
    logger.warn({ projectId, err }, "[e2b] could not read project variables");
    return [];
  }
}

/**
 * Writes the preview `.env` with the Supabase credentials the generated app
 * needs to initialise its client. Must run BEFORE the dev server starts — Vite
 * only reads VITE_* env at startup, so injecting after boot wouldn't take.
 * No-op if no preview Supabase project is configured.
 */
async function writePreviewEnv(sandbox: Sandbox, projectId: string, log: PreviewLogCallback): Promise<void> {
  // Prefer the USER'S own connected Supabase project (set per-project at build
  // start) over the shared preview project — so each user's app runs on their
  // own database. The anon key is public/RLS-safe.
  const override = projectPreviewEnv.get(projectId);
  let url = override?.url ?? config.PREVIEW_SUPABASE_URL;
  let anon = override?.anonKey ?? config.PREVIEW_SUPABASE_ANON_KEY;
  if (override) log("Using the project owner's connected Supabase for the preview");

  // SAFETY: never point a generated preview app at Lampcode's OWN Supabase
  // project — test sign-ups/data would pollute the real product. Drop it.
  if (url && config.SUPABASE_URL && url === config.SUPABASE_URL) {
    logger.error({ url }, "[e2b] REFUSING preview Supabase = platform SUPABASE_URL (data-safety)");
    log("⚠️ Preview Supabase = platform Supabase — skipping Supabase env. Use a separate preview project.");
    url = undefined;
    anon = undefined;
  }

  const serviceKey = override?.serviceKey ?? config.PREVIEW_SUPABASE_SERVICE_KEY;
  const mongoUri = config.PREVIEW_MONGODB_URI;

  // VITE_* → frontend (import.meta.env); plain keys → Node backend (process.env
  // via tsx --env-file). SERVICE/JWT/MONGO keys have NO VITE_ prefix, so Vite
  // never exposes them to the browser. A JWT secret is always provided so
  // MongoDB apps can do custom auth.
  let env = "";
  if (url && anon) {
    env +=
      `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n` +
      `SUPABASE_URL=${url}\nSUPABASE_ANON_KEY=${anon}\n` +
      (serviceKey ? `SUPABASE_SERVICE_KEY=${serviceKey}\nSUPABASE_SERVICE_ROLE_KEY=${serviceKey}\n` : "");
    if (serviceKey) log("Backend has service-role access to Supabase");
  }
  if (mongoUri) {
    env += `MONGODB_URI=${mongoUri}\n`;
    log("Backend has a MongoDB connection (MONGODB_URI)");
  }
  // Stable per-project secret for custom (MongoDB) JWT auth.
  env += `JWT_SECRET=lampcode_${projectId}\n`;

  // The project's OWN variables, last so they win on a name clash: the person
  // set them deliberately for their own app, and the platform defaults are
  // only defaults.
  //
  // These were stored and never used. A key saved in project settings reached
  // the database and stopped there — e2b-service never read the table — so
  // every generated app that needed one ran without it, silently. That covers
  // the AI-agent path the template ships crewai, langgraph and
  // langchain-anthropic for: all installed, none of them able to authenticate.
  const ownVars = await loadProjectEnvVars(projectId);
  if (ownVars.length > 0) {
    for (const { key, value } of ownVars) env += `${key}=${value}\n`;
    log(`Injected ${ownVars.length} project variable(s) from your settings`);
  }

  if (!env.trim()) {
    log("No preview DB configured — skipping .env injection");
    return;
  }
  try {
    await sandbox.files.write(`${PROJECT_DIR}/.env`, env);
    log("Injected preview Supabase credentials into .env");
  } catch (err) {
    logger.warn({ err }, "[e2b] Failed to write preview .env");
  }
}

/**
 * Strip `baseUrl` from the sandbox's tsconfig.json.
 *
 * The template bakes `"baseUrl": "."`, and it installs TypeScript globally at
 * image-build time, which now resolves to a version where that option was
 * REMOVED. So `tsc --noEmit` fails on the config itself with TS5102 and never
 * reaches the app's code — which is why runTypeCheck has been reporting one
 * config error and nothing else on every build, missing real type errors
 * (including missing-module errors) entirely.
 *
 * `paths` still resolves without `baseUrl` under `moduleResolution: "bundler"`,
 * so dropping it is the whole fix. Done at runtime rather than only in
 * template.ts so it takes effect without an E2B template rebuild; template.ts
 * is corrected too, for the next rebuild.
 *
 * tsconfig.json is in BAKED_FILES, so this deliberately writes it directly
 * rather than going through writeFiles().
 */
async function patchSandboxTsconfig(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  const path = `${PROJECT_DIR}/tsconfig.json`;
  try {
    const raw = await sandbox.files.read(path);
    const parsed = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
    if (parsed.compilerOptions?.["baseUrl"] === undefined) return; // already fine
    delete parsed.compilerOptions["baseUrl"];
    await sandbox.files.write(path, JSON.stringify(parsed, null, 2));
    log("Removed tsconfig baseUrl (removed in current TypeScript)");
  } catch (err) {
    // Never fail a build over this — the type check degrades to what it
    // already does today rather than the preview not coming up.
    logger.warn({ err }, "[e2b] could not patch tsconfig.json");
  }
}

/**
 * Ambient module declarations for non-code imports (CSS, images, fonts).
 *
 * The template's own `src/index.tsx` does `import './styles.css'`, which is
 * normal Vite and normal at runtime, but TypeScript has no idea what a `.css`
 * module is without a declaration and reports TS2882 for it. Nothing caught
 * this before because tsc was failing on the config (see patchSandboxTsconfig)
 * and never reached any code; with that fixed, this became the first error on
 * EVERY build — in a file the fix loop cannot repair, because the problem is a
 * missing declaration rather than anything wrong with the import.
 *
 * Lives under src/ because the baked tsconfig has `include: ["src"]`.
 */
const VITE_ENV_DTS = `/// <reference types="vite/client" />
declare module '*.css';
declare module '*.scss';
declare module '*.sass';
declare module '*.less';
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.gif';
declare module '*.webp';
declare module '*.avif';
declare module '*.woff';
declare module '*.woff2';
`;

async function patchSandboxTypeShims(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  try {
    await sandbox.files.write(`${PROJECT_DIR}/src/vite-env.d.ts`, VITE_ENV_DTS);
  } catch (err) {
    logger.warn({ err }, "[e2b] could not write src/vite-env.d.ts");
    log("Could not add asset type declarations — the type check may report CSS imports as errors");
  }
}

/** npm package name: optional @scope/, then the name. The first character is
 * deliberately narrower than the rest — a leading hyphen is not a legal npm
 * name, and a "package" called `-g` would be read by npm as a FLAG rather than
 * an operand. `--` is also passed on the command line below, so a name would
 * have to defeat both to be treated as an option.
 */
const NPM_NAME_RE = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
/** Most apps add a handful of libraries; a request for 30 is a runaway, not a build. */
const MAX_EXTRA_DEPS = 12;

/**
 * Install dependencies the generated app declares but the template doesn't ship.
 *
 * The model writes its package.json like any other file, but package.json is in
 * BAKED_FILES, so that declaration was silently dropped and nothing installed
 * it — an app importing `recharts` would build "successfully" and then fail to
 * resolve the import in the browser. The model was doing the right thing and
 * the system was throwing it away.
 *
 * Runtime `npm install` was removed from this service once before, because
 * installing into a RUNNING dev server crashed it ("no service on port 5173").
 * That reasoning still holds and is why this is called before the dev server
 * starts, never underneath a live one.
 *
 * Names are validated rather than passed through: they come from model output,
 * and npm's install syntax accepts URLs, git refs and local paths, none of
 * which should be reachable from here.
 */
/**
 * Bare package specifiers imported by the generated source.
 *
 * Reading the model's package.json was the only way a package got installed,
 * and on 2026-10-04 that proved too fragile to rely on: three builds imported
 * react-router-dom — which the prompt now asks for on any multi-view app — and
 * not one of them emitted a package.json to declare it. Vite then failed with
 * "Failed to resolve import", the preview never came up, and the app was dead
 * on arrival.
 *
 * So the declaration is no longer load-bearing. What the code actually imports
 * is the truth, and it is right there in the files we are about to write.
 *
 * Relative paths, the @/ alias and node: builtins are not packages. A scoped
 * name keeps two segments (@scope/pkg); everything else keeps one, so
 * "react-dom/client" resolves to the "react-dom" package.
 */
export function importedPackages(files: Record<string, string>): string[] {
  const found = new Set<string>();
  const SPEC_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const [path, code] of Object.entries(files)) {
    if (!/\.(tsx?|jsx?|mts|mjs)$/.test(path)) continue;
    for (const m of code.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) continue;
      if (spec.startsWith("node:")) continue;
      const parts = spec.split("/");
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (name && NPM_NAME_RE.test(name)) found.add(name);
    }
  }
  return [...found];
}

async function installExtraDependencies(
  sandbox: Sandbox,
  files: Record<string, string>,
  log: PreviewLogCallback,
): Promise<void> {
  // Two sources, union'd: what the model DECLARED, and what its code actually
  // IMPORTS. The second exists because the first is routinely absent — see
  // importedPackages. Either alone misses real cases, so take both.
  const declaredNames: string[] = [];
  const declared = files["package.json"];
  if (declared) {
    try {
      const parsed = JSON.parse(declared) as { dependencies?: Record<string, string> };
      declaredNames.push(...Object.keys(parsed.dependencies ?? {}));
    } catch {
      log("Generated package.json is not valid JSON — using its imports instead");
    }
  }
  const wantedNames = [...new Set([...declaredNames, ...importedPackages(files)])];
  if (wantedNames.length === 0) return;

  let already: Record<string, string> = {};
  try {
    const baked = JSON.parse(await sandbox.files.read(`${PROJECT_DIR}/package.json`)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // devDependencies count as installed. vitest, jsdom and testing-library all
    // live there, and a test file importing vitest would otherwise look like a
    // missing package on every single build that writes one.
    already = { ...baked.dependencies, ...baked.devDependencies };
  } catch {
    // Can't tell what's installed — installing everything the app asks for is
    // still better than installing nothing, and npm no-ops what's present.
  }

  const missing = wantedNames.filter((n) => !(n in already));
  const valid = missing.filter((n) => NPM_NAME_RE.test(n));
  const rejected = missing.filter((n) => !NPM_NAME_RE.test(n));
  if (rejected.length > 0) {
    logger.warn({ rejected }, "[e2b] refused to install packages with invalid names");
    log(`Skipped ${rejected.length} package(s) with unusable names.`);
  }
  if (valid.length === 0) return;

  const toInstall = valid.slice(0, MAX_EXTRA_DEPS);
  if (valid.length > toInstall.length) {
    log(`Installing the first ${MAX_EXTRA_DEPS} of ${valid.length} extra packages.`);
  }

  log(`Installing ${toInstall.length} extra package(s): ${toInstall.join(", ")}...`);
  try {
    await sandbox.commands.run(
      // --no-save keeps the baked package.json authoritative; --legacy-peer-deps
      // matches how the template installed its own deps (React 19 vs peers).
      // `--` ends option parsing, so everything after it is an operand even if
      // a name somehow got past NPM_NAME_RE.
      `npm install --no-save --legacy-peer-deps -- ${toInstall.join(" ")}`,
      { cwd: PROJECT_DIR, timeoutMs: 180_000 },
    );
    log(`Installed: ${toInstall.join(", ")}`);
  } catch (err) {
    // A package that doesn't exist, or a registry hiccup. The app will fail on
    // that import and the user sees why, which beats failing the whole preview.
    logger.warn({ err, toInstall }, "[e2b] extra dependency install failed");
    log(`Could not install: ${toInstall.join(", ")}. Imports of those will fail.`);
  }
}

/**
 * Runs inside the reference page. Kept as a source string because it is
 * serialised into a script that executes in the sandbox, not here.
 *
 * Verified against a realistic dark agency page before shipping: it recovered
 * the accent colour, both font families, the 76/42/22/17 type scale and the
 * section order — which is the whole vocabulary a "make it feel like this"
 * request actually needs.
 */
const PAGE_EXTRACTOR = `() => {
  const rgb = (s) => {
    const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(s || "");
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null;   // ~transparent
    return [ +m[1], +m[2], +m[3] ];
  };
  const hex = (c) => "#" + c.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const bgCount = new Map(), fgCount = new Map(), fonts = new Set();
  let sampled = 0;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;          // spacers and hidden nodes
    if (sampled++ > 1500) break;                        // cap work on huge pages
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const bg = rgb(cs.backgroundColor);
    // Area-weighted: a full-bleed section should outrank a hundred small chips.
    if (bg) bgCount.set(hex(bg), (bgCount.get(hex(bg)) ?? 0) + Math.min(r.width * r.height, 2000000));
    const fg = rgb(cs.color);
    if (fg && el.textContent && el.textContent.trim().length > 1) {
      fgCount.set(hex(fg), (fgCount.get(hex(fg)) ?? 0) + 1);
    }
    const fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
    if (fam) fonts.add(fam);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const headings = [];
  for (const h of document.querySelectorAll("h1, h2, h3")) {
    const t = (h.textContent || "").trim().replace(/\\s+/g, " ");
    if (t && t.length < 90) headings.push(h.tagName.toLowerCase() + ": " + t);
    if (headings.length >= 24) break;
  }
  const sizeOf = (s) => {
    const el = document.querySelector(s);
    return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : null;
  };
  const bodyBg = rgb(getComputedStyle(document.body).backgroundColor) ?? [255,255,255];
  return {
    title: (document.title || "").slice(0, 120),
    theme: lum(bodyBg) < 0.5 ? "dark" : "light",
    backgrounds: top(bgCount, 5),
    textColors: top(fgCount, 5),
    fonts: [...fonts].slice(0, 6),
    typeScale: { h1: sizeOf("h1"), h2: sizeOf("h2"), h3: sizeOf("h3"), body: sizeOf("p") },
    sections: headings,
  };
}`;

/**
 * Reject URLs a reference fetch has no business loading.
 *
 * The fetch runs in the sandbox, so our own network is already out of reach —
 * but the sandbox can still reach its own localhost, where the generated app
 * and its dev server live. Honest about its limit: this blocks literal
 * internal addresses, not a public hostname that resolves to one.
 */
export function isFetchableReferenceUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return false;
  if (/^127\./.test(h) || /^0\./.test(h)) return false;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;              // cloud metadata
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h)) return false;    // IPv6 unique-local
  return true;
}

/**
 * Load a reference page in the sandbox's headless browser and extract the
 * design vocabulary from it — palette, fonts, type scale, section order.
 *
 * Deliberately returns a BRIEF, not the page. What makes something "feel like"
 * a reference is colour, type and rhythm — not its copy, its images or its
 * exact layout. Handing back page source would invite reproducing it, which is
 * both a worse result and a problem for whoever's site is being cloned.
 *
 * Runs inside the sandbox rather than from this server, so a user-supplied URL
 * never becomes an outbound request from our own process and cannot be aimed at
 * anything on our network. The sandbox can still reach its own localhost, which
 * is why the caller validates the URL before this is reached.
 */
export async function fetchReferenceDesign(
  projectId: string,
  url: string,
): Promise<Record<string, unknown>> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) throw new Error("no live sandbox for this project");

  const script = [
    'import { chromium } from "playwright";',
    'const b = await chromium.launch();',
    'const p = await b.newPage({ viewport: { width: 1440, height: 900 } });',
    'let out;',
    'try {',
    '  await p.goto(' + JSON.stringify(url) + ', { waitUntil: "domcontentloaded", timeout: 25000 });',
    '  await p.waitForTimeout(2500);',
    '  out = await p.evaluate(' + PAGE_EXTRACTOR + ');',
    '} catch (e) {',
    '  out = { error: String(e).slice(0, 200) };',
    '}',
    'await b.close();',
    'process.stdout.write("JSON:" + JSON.stringify(out));',
  ].join("\n");

  await sandbox.files.write(`${TOOLS_DIR}/lampcode-ref.mjs`, script);
  const r = await sandbox.commands.run(
    `${TOOLS_ENV} node ${TOOLS_DIR}/lampcode-ref.mjs`,
    { timeoutMs: 60_000 },
  );
  const marker = r.stdout.indexOf("JSON:");
  if (marker === -1) {
    logger.warn(
      { projectId, url, stdoutHead: r.stdout.slice(0, 300), stderrHead: r.stderr.slice(0, 300) },
      "[e2b] fetchReferenceDesign produced no result — reference fetch is not working",
    );
    throw new Error("the reference page could not be read");
  }
  return JSON.parse(r.stdout.slice(marker + 5).trim()) as Record<string, unknown>;
}

/**
 * Whether the template owns this path, so a generated copy of it is discarded
 * on the way into the sandbox. Exported because callers outside this module
 * need to know a rewrite of such a file can never take effect — asking a model
 * to fix one is spend with no possible result.
 */
export function isTemplateOwnedFile(path: string): boolean {
  return BAKED_FILES.has(path);
}

async function writeFiles(
  sandbox: Sandbox,
  files: Record<string, string>,
  log: PreviewLogCallback,
): Promise<void> {
  const writable = Object.entries(files).filter(
    ([path]) =>
      !BAKED_FILES.has(path) &&
      // LLM-controlled paths: block traversal/absolute escapes out of PROJECT_DIR.
      !path.includes("..") &&
      !path.startsWith("/"),
  );
  const skipped = Object.keys(files).length - writable.length;
  log(`Writing ${writable.length} files...${skipped ? ` (${skipped} baked config file(s) skipped)` : ""}`);
  try {
    await Promise.all(
      writable.map(([path, content]) =>
        sandbox.files.write(`${PROJECT_DIR}/${path}`, content),
      ),
    );
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to write files to sandbox");
    throw err;
  }
}

async function saveSandboxId(projectId: string, sandboxId: string, framework: FullstackFramework): Promise<void> {
  try {
    await withRedisTimeout(redis.set(redisKey(projectId), sandboxId, "EX", SANDBOX_REDIS_TTL_SECONDS), "set sandboxId");
    await withRedisTimeout(redis.set(frameworkRedisKey(projectId), framework, "EX", SANDBOX_REDIS_TTL_SECONDS), "set framework");
  } catch (err) {
    // The sandbox itself is already live and registered in-process — losing
    // only its durable record is not worth failing the build over. Worst
    // case it isn't resumable after a restart and cold-starts instead.
    // Every failure mode is handled the same way, not just the timeout: with
    // the offline queue disabled an unreachable Redis rejects immediately
    // rather than timing out, and re-throwing that would fail a build over a
    // cache write.
    logger.warn({ projectId, sandboxId, err }, "[e2b] Redis write failed — sandbox not persisted");
  }
}

async function loadFramework(projectId: string): Promise<FullstackFramework | null> {
  try {
    const f = await withRedisTimeout(redis.get(frameworkRedisKey(projectId)), "get framework");
    return (f as FullstackFramework) ?? null;
  } catch {
    return null;
  }
}

async function loadSandboxId(projectId: string): Promise<string | null> {
  try {
    return await withRedisTimeout(redis.get(redisKey(projectId)), "get sandboxId");
  } catch (err) {
    // Treat any failure as a cache miss: the caller cold-starts a fresh
    // sandbox, which is strictly better than hanging or failing. Any orphaned
    // sandbox is bounded by its own SANDBOX_TIMEOUT_MS lifetime.
    logger.warn({ projectId, err }, "[e2b] Redis read failed — treating as no cached sandbox");
    return null;
  }
}

async function deleteSandboxId(projectId: string): Promise<void> {
  try {
    await withRedisTimeout(redis.del(redisKey(projectId)), "del sandboxId");
    await withRedisTimeout(redis.del(frameworkRedisKey(projectId)), "del framework");
  } catch (err) {
    // Same reasoning: the record carries a TTL, so a failed delete expires on
    // its own. Nothing here is worth propagating to a caller.
    logger.warn({ projectId, err }, "[e2b] Redis delete failed — stale record left to expire via TTL");
  }
}

/**
 * Tries to resume a previously-paused sandbox by ID. The E2B SDK exposes
 * resumption through `Sandbox.connect()` — if the sandbox is paused it is
 * automatically resumed; there is no separate `resume()` API. Returns `null`
 * if the snapshot is gone (expired/evicted) so the caller can fall back to
 * creating a fresh sandbox.
 */
async function tryResumeSandbox(projectId: string, sandboxId: string): Promise<Sandbox | null> {
  try {
    const sandbox = await Sandbox.connect(sandboxId, {
      ...(config.E2B_API_KEY ? { apiKey: config.E2B_API_KEY } : {}),
      // CRITICAL: connect/resume defaults the sandbox lifetime to 5 minutes
      // (same SDK default as create) — without this every resumed sandbox
      // died 5 minutes later, killing the preview mid-session.
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    console.log("[E2B] Resumed sandbox:", sandboxId, "for project:", projectId);
    return sandbox;
  } catch (err) {
    logger.warn({ projectId, sandboxId, err }, "[e2b] Failed to resume sandbox — snapshot likely expired");
    await deleteSandboxId(projectId);
    return null;
  }
}

// NOTE: no runtime `npm install` anywhere in this service — deps are baked
// into the template (skill rule: template owns package.json/node_modules).
// Runtime installs were a root cause of dev-server crashes mid-session.

/**
 * Wraps a PreviewLogCallback so each line is also captured in a rolling
 * in-memory buffer (last `maxLines` lines). Used to collect dev-server output
 * for diagnostics when waitForServerReady times out.
 */
/** Recent dev-server (Vite/Next) output per sandbox, for readSandboxLogs(). */
const devLogs = new Map<string, string[]>();

function makeDevLog(
  log: PreviewLogCallback,
  sandboxId?: string,
  maxLines = 80,
): { log: PreviewLogCallback; last: () => string[] } {
  const buf: string[] = [];
  // Registered per sandbox so the buffer outlives this call. It used to be
  // purely local, readable only by the one diagnostic that took it as an
  // argument — but "why is the page blank" is usually answered in this output,
  // and an agent that can't read it has to guess.
  if (sandboxId) devLogs.set(sandboxId, buf);
  return {
    log: (line: string) => {
      log(line);
      buf.push(line);
      if (buf.length > maxLines) buf.shift();
    },
    last: () => buf.slice(),
  };
}

/**
 * Runs a quick liveness probe (pgrep) and returns a diagnostic string
 * containing process status + the buffered last lines of dev-server output.
 * Never throws — if the probe itself fails we still return a useful partial
 * message so the original timeout error is enriched, not lost.
 */
async function fetchDevServerDiag(
  sandbox: Sandbox,
  framework: FullstackFramework,
  lastLines: string[],
): Promise<string> {
  let processStatus = "UNKNOWN";
  try {
    const killPat = devKillPattern(framework);
    const probe = await sandbox.commands.run(`pgrep -f '${killPat}' && echo ALIVE || echo DEAD`, {
      timeoutMs: 10_000,
    });
    processStatus = probe.stdout.trim().includes("ALIVE") ? "ALIVE" : "DEAD";
  } catch {
    // probe command failed (sandbox may already be dead) — leave as UNKNOWN
  }
  const output = lastLines.join("\n").trim();
  return `Process: ${processStatus}. Last output:\n${output || "(no output captured)"}`;
}

async function startDevServer(
  sandbox: Sandbox,
  log: PreviewLogCallback,
  framework: FullstackFramework,
): Promise<void> {
  const cmd = devStartCommand(framework);
  try {
    log(`Starting dev server (${framework})...`);
    await sandbox.commands.run(cmd, {
      cwd: PROJECT_DIR,
      background: true,
      // CRITICAL: the SDK's default command timeout is 60s and it applies to
      // background commands too — without this, E2B killed the dev server one
      // minute after boot ("no service running on port …").
      // 0 = no timeout; the dev server lives as long as the sandbox.
      timeoutMs: 0,
      onStdout: log,
      onStderr: log,
    });
  } catch (err) {
    logger.error({ err }, "[e2b] Failed to start dev server");
    throw err;
  }
}

function previewUrlFor(sandbox: Sandbox, framework: FullstackFramework): string {
  // Use the SDK's getHost() — it returns the correct public preview host for
  // this E2B deployment (domain + region). A hardcoded "port-{id}.e2b.dev"
  // string is fragile and was the cause of preview URLs that never resolved.
  return `https://${sandbox.getHost(devPort(framework))}`;
}

/**
 * Self-healing guard: makes sure Vite is actually listening before we hand the
 * preview URL to the client. Covers every "the sandbox exists" path — resumed
 * snapshots whose dev server died, processes killed by timeouts/OOM, etc.
 * Quick single probe when healthy (~one HTTP round-trip).
 */
async function ensureDevServer(
  sandbox: Sandbox,
  log: PreviewLogCallback,
  framework: FullstackFramework,
): Promise<void> {
  const url = previewUrlFor(sandbox, framework);
  let serverUp = false;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000) });
    serverUp = res.ok || res.status < 500;
  } catch {
    // not listening — restart below
  }
  if (!serverUp) {
    log(`Dev server not responding — (re)starting ${framework} dev server...`);
    // Kill any half-dead process first so the restart won't lose a port conflict.
    const killPat = devKillPattern(framework);
    await sandbox.commands.run(`pkill -f ${killPat} || true`, { timeoutMs: 10_000 }).catch(() => {});
    const devLog = makeDevLog(log, sandbox.sandboxId);
    await startDevServer(sandbox, devLog.log, framework);
    const ready = await waitForServerReady(url, framework);
    if (!ready) {
      const diag = await fetchDevServerDiag(sandbox, framework, devLog.last());
      throw new Error(`Dev server did not respond at ${url} within ${readyPollTimeoutMs(framework) / 1000}s. ${diag}`);
    }
    log("Dev server is up");
  }
  // Also (re)start the app's own Hono/Node backend if it ships one — no-op for
  // Next.js/TanStack (Route Handlers / createServerFn are served by the framework).
  if (framework === "react") {
    await ensureBackendServer(sandbox, log).catch(() => {});
  }
}

/**
 * Starts the app's REAL backend inside the sandbox when it ships one
 * (src/server/index.ts). The backend (Hono/Node) listens on :3001 and Vite
 * proxies /api/* to it, so generated apps can serve real API routes
 * (/api/riders, /api/orders, Stripe webhooks, …) — not just Supabase-direct
 * calls. Always (re)started after a write so it runs the latest code; no-op for
 * frontend-only / Supabase-direct apps. Runs under tsx (baked in the template).
 */
async function ensureBackendServer(sandbox: Sandbox, log: PreviewLogCallback): Promise<void> {
  // Detect the backend's runtime by its entry file: Node/Hono (src/server/index.ts)
  // or Python/FastAPI (src/server/main.py). Either runs on :3001.
  let runtime: "node" | "python" | null = null;
  let envText = "";
  try {
    const r = await sandbox.commands.run(
      "test -f src/server/index.ts && echo NODE; test -f src/server/main.py && echo PY; cat .env 2>/dev/null || true",
      { cwd: PROJECT_DIR, timeoutMs: 10_000 },
    );
    if (r.stdout.includes("PY")) runtime = "python";
    else if (r.stdout.includes("NODE")) runtime = "node";
    envText = r.stdout;
  } catch {
    return;
  }
  if (!runtime) return;

  // Parse .env (KEY=VALUE lines) so we can pass Supabase creds to BOTH runtimes
  // uniformly via the process env (Python's uvicorn doesn't read --env-file).
  const envs: Record<string, string> = { PORT: "3001" };
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] && m[2] !== undefined) envs[m[1]] = m[2];
  }

  await sandbox.commands.run("pkill -f 'src/server/index' || true; pkill -f uvicorn || true", { timeoutMs: 10_000 }).catch(() => {});
  log(`Starting ${runtime} backend server on :3001...`);
  const buf: string[] = [];
  backendLogs.set(sandbox.sandboxId, buf);
  const capture = (line: string): void => {
    log(line);
    buf.push(line);
    if (buf.length > 80) buf.shift();
  };

  // Node: tsx runs the Hono server. Python: uvicorn serves the FastAPI `app`
  // from src/server/main.py (run from that dir so `main:app` resolves).
  const cmd =
    runtime === "python"
      ? "cd src/server && python3 -m uvicorn main:app --host 0.0.0.0 --port 3001"
      : "tsx src/server/index.ts";
  try {
    await sandbox.commands.run(cmd, {
      cwd: PROJECT_DIR,
      background: true,
      timeoutMs: 0, // lives as long as the sandbox (default 60s would kill it)
      envs,
      onStdout: capture,
      onStderr: capture,
    });
  } catch (err) {
    logger.warn({ err }, "[e2b] Failed to start backend server");
  }
}

// Recent backend stdout/stderr per sandbox, for the agentic verify-and-fix step.
const backendLogs = new Map<string, string[]>();

function extractBackendError(lines: string[]): string {
  const text = lines.join("\n");
  // Pull the most informative error lines (stack header + message).
  const errLines = lines.filter((l) => /error|exception|cannot|undefined|not a function|ENOENT|throw|SyntaxError|TypeError|ReferenceError/i.test(l));
  return (errLines.slice(-12).join("\n") || text.slice(-1200)).trim();
}

export interface PreviewIssue {
  source: string;
  message: string;
}

/**
 * Result of a sandbox quality gate. `ok` keeps its original meaning — "do not
 * trigger the auto-fix loop" — so every existing caller that destructures
 * `{ ok, issues }` behaves exactly as before.
 *
 * `unavailable` is the state that was previously unrepresentable: the gate
 * could not run at all (no sandbox, unreachable, tooling missing, unparseable
 * output). That has always been reported as `ok: true`, because failing a
 * delivered build on our own infrastructure trouble would be worse. But it
 * makes "not run" and "passed" identical to the caller, and a caller that
 * cannot tell them apart cannot be honest about it — which matters most for
 * anything that reports a verdict onward, to a user or to a model deciding
 * whether its work is done. Telling an agent "no type errors" when tsc never
 * ran is how it ships broken code believing it checked.
 */
export interface GateResult {
  ok: boolean;
  issues: PreviewIssue[];
  /** True when the gate could not run. `ok` is still true — see above. */
  unavailable?: boolean;
}

function skippedGate(projectId: string, gate: string): GateResult {
  logger.warn({ projectId, gate }, "[e2b] gate skipped — no live sandbox; build is UNVERIFIED");
  return { ok: true, issues: [], unavailable: true };
}

/**
 * Agentic verification: after the app is written and the servers (re)started,
 * checks whether the REAL backend actually came up. If the Hono server crashed
 * on startup (bad import, runtime error, etc.) the preview's /api calls would
 * silently fail — instead we capture its error so the build flow can re-prompt
 * the model to fix src/server and try again. No-op for frontend-only apps.
 */
export async function verifyPreview(projectId: string): Promise<GateResult> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return skippedGate(projectId, "verifyPreview");

  let hasBackend = false;
  try {
    const r = await sandbox.commands.run(
      "test -f src/server/index.ts -o -f src/server/main.py && echo y",
      { cwd: PROJECT_DIR, timeoutMs: 10_000 },
    );
    hasBackend = r.stdout.includes("y");
  } catch {
    // Couldn't even probe for a backend — the sandbox is unreachable, so
    // nothing was checked.
    return { ok: true, issues: [], unavailable: true };
  }
  if (!hasBackend) return { ok: true, issues: [] };

  // Give the backend a moment, then check it's listening. Any HTTP status
  // (even 404) means it's up; a refused connection means it crashed.
  await new Promise((r) => setTimeout(r, 2_500));
  let up = false;
  try {
    const probe = await sandbox.commands.run(
      "curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3001/ || echo DOWN",
      { timeoutMs: 12_000 },
    );
    const code = probe.stdout.trim();
    up = code !== "" && code !== "DOWN" && code !== "000";
  } catch {
    up = false;
  }

  if (up) return { ok: true, issues: [] };
  const message = extractBackendError(backendLogs.get(sandbox.sandboxId) ?? []) || "backend did not start on port 3001";
  return { ok: false, issues: [{ source: "src/server/index.ts", message }] };
}

/**
 * What a test run actually found.
 *
 * Deliberately not a GateResult. A GateResult has two states plus
 * "unavailable", and a test run has four that matter: the tests passed, the
 * tests failed, there are no tests, or the runner could not run. Collapsing
 * "no tests" into a pass is the failure mode worth designing against — an
 * agent that writes nothing and is told "tests passed" has been handed proof
 * of correctness it never earned.
 */
export type TestRunResult = {
  outcome: "passed" | "failed" | "none" | "unavailable";
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ test: string; message: string }>;
  /** Why it couldn't run, when outcome is "unavailable". */
  reason?: string;
};

// Vitest's JSON reporter is jest-compatible. Only the fields used here are
// declared; the report carries a great deal more.
type VitestJsonReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: Array<{
    name?: string;
    assertionResults?: Array<{
      fullName?: string;
      title?: string;
      status?: string;
      failureMessages?: string[];
    }>;
  }>;
};

const VITEST_RESULT_PATH = "/tmp/lampcode-vitest.json";
const VITEST_EXIT_MARKER = "__LAMPCODE_VITEST_EXIT__";

/**
 * Reduce one vitest failure message to the part the model can act on.
 *
 * A raw message is the assertion ("expected 120 to be 108") followed by a
 * stack, most of which is absolute paths inside the sandbox's node_modules.
 * Those frames cost context and tell the model nothing it can use — but the
 * ONE frame that points at the project's own file is exactly what it needs to
 * find the failing line, so that is kept and the rest dropped.
 */
function summarizeFailure(raw: string): string {
  const lines = raw.split("\n");
  const assertion: string[] = [];
  let projectFrame: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("at ")) {
      // Collect prose until the project's own frame is found, capped at 8
      // lines. The cap is what keeps @testing-library's failure report — which
      // prints the whole rendered DOM — from running away, while still keeping
      // its first few lines, where it says what it could not find.
      if (projectFrame === null && assertion.length < 8) assertion.push(t);
      continue;
    }
    if (projectFrame === null && !t.includes("node_modules")) projectFrame = t;
  }
  return [...assertion, ...(projectFrame ? [projectFrame] : [])]
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

/**
 * Run the project's vitest suite inside its sandbox and report what happened.
 *
 * vitest, jsdom and @testing-library live in the generated app's OWN
 * devDependencies (template.ts), not in .lampcode-tools like playwright: a
 * test file does `import { describe } from "vitest"`, and Node resolves a bare
 * specifier relative to the IMPORTING FILE, so a vitest installed anywhere
 * else is invisible to the tests that need it.
 *
 * The JSON reporter writes to a file under /tmp rather than stdout: the run's
 * own console output (a test's own logs, vite's warnings) shares stdout and
 * there is no reliable way to tell where the report begins. /tmp also keeps it
 * out of the project directory, where Vite's polling watcher would see it
 * appear and the file would end up in the user's project.
 */
export async function runTests(projectId: string): Promise<TestRunResult> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) {
    logger.warn({ projectId, gate: "runTests" }, "[e2b] gate skipped — no live sandbox");
    return { outcome: "unavailable", total: 0, passed: 0, failed: 0, failures: [], reason: "no live sandbox" };
  }

  // `;` not `&&`: a failing suite exits non-zero, which is the normal path
  // here, and the report still has to be read. The marker carries the real
  // exit code through, since the shell's own status is now always 0.
  const command =
    `rm -f ${VITEST_RESULT_PATH}; ` +
    `npx vitest run --reporter=json --outputFile=${VITEST_RESULT_PATH} 2>&1; ` +
    `echo "${VITEST_EXIT_MARKER}$?"; ` +
    `cat ${VITEST_RESULT_PATH} 2>/dev/null`;

  let output = "";
  try {
    const r = await sandbox.commands.run(command, {
      cwd: PROJECT_DIR,
      // Generously above the per-test 10s in vitest.config.ts: a cold first
      // run pays for vite's transform of every imported module.
      timeoutMs: 180_000,
    });
    output = r.stdout;
  } catch (err) {
    if (err instanceof CommandExitError) {
      output = err.stdout;
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ projectId, err: reason }, "[e2b] runTests could not run");
      return { outcome: "unavailable", total: 0, passed: 0, failed: 0, failures: [], reason };
    }
  }

  const result = parseVitestOutput(output);
  if (result.outcome === "unavailable") {
    // Logged here rather than in the parser, which stays pure so it can be
    // tested. Without this, a run that never produced a report left no trace
    // of why — missing vitest, a crash on startup and a timeout all read the
    // same from outside.
    logger.warn({ projectId, reason: result.reason }, "[e2b] runTests produced no parseable report");
  }
  return result;
}

/**
 * Pull a TestRunResult out of what the sandbox command printed.
 *
 * Separate and exported so it can be checked against real vitest output
 * (scripts/vitest-parse.test.ts) rather than trusted. Each branch here stands
 * for a specific way a run goes wrong, and a parser that reads a failing run
 * as a pass would be worse than having no test tool at all.
 */
export function parseVitestOutput(output: string): TestRunResult {
  const markerAt = output.indexOf(VITEST_EXIT_MARKER);
  const consoleOutput = markerAt === -1 ? output : output.slice(0, markerAt);
  const afterMarker = markerAt === -1 ? "" : output.slice(markerAt + VITEST_EXIT_MARKER.length);
  // The marker line is "<exit code>\n"; the report follows it.
  const newlineAt = afterMarker.indexOf("\n");
  const reportText = newlineAt === -1 ? "" : afterMarker.slice(newlineAt + 1).trim();

  let report: VitestJsonReport | null = null;
  if (reportText.startsWith("{")) {
    try {
      report = JSON.parse(reportText) as VitestJsonReport;
    } catch {
      // Fall through to the text-based readings below — a half-written report
      // is no worse than no report.
    }
  }

  if (!report) {
    // Two cases that are NOT "the tests failed", and must not be reported as
    // though they were.
    if (/No test files found/i.test(consoleOutput)) {
      return { outcome: "none", total: 0, passed: 0, failed: 0, failures: [] };
    }
    const reason =
      /not found|could not determine executable|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(consoleOutput)
        ? "vitest is not installed in this sandbox — its template predates the test tooling"
        : `vitest produced no report. Output:\n${consoleOutput.slice(-1_500)}`;
    return { outcome: "unavailable", total: 0, passed: 0, failed: 0, failures: [], reason };
  }

  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;

  const failures: Array<{ test: string; message: string }> = [];
  for (const suite of report.testResults ?? []) {
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      const name = a.fullName || a.title || suite.name || "unnamed test";
      const message = (a.failureMessages ?? []).map(summarizeFailure).join("\n").trim();
      failures.push({ test: name, message: message || "failed with no message" });
    }
  }

  if (total === 0) return { outcome: "none", total: 0, passed: 0, failed: 0, failures: [] };
  return { outcome: failed > 0 ? "failed" : "passed", total, passed, failed, failures };
}


// tsc --pretty false emits one line per diagnostic:
//   src/components/Header.tsx(12,5): error TS2339: Property 'foo' does not exist on type 'Bar'.
const TSC_DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;

/**
 * Type-check the generated project inside its own sandbox, where the real
 * dependency graph (react, hono, supabase, etc — the template's baked
 * node_modules) and the real tsconfig.json already live. Checking in-memory
 * in the Lampcode process instead would need a duplicate copy of every
 * package the template installs just to resolve types, and would report
 * "cannot find module" on all of them — not real errors, just noise.
 * typescript is globally installed in the template (no install step, no
 * network dependency), so this runs immediately after files are written.
 * No-op (ok:true) if no live in-process sandbox exists for this project —
 * same silent-skip behavior as verifyPreview.
 */
export async function runTypeCheck(projectId: string): Promise<GateResult> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return skippedGate(projectId, "runTypeCheck");

  let stdout = "";
  try {
    const r = await sandbox.commands.run("tsc --noEmit --pretty false", {
      cwd: PROJECT_DIR,
      timeoutMs: 60_000,
    });
    stdout = r.stdout;
  } catch (err) {
    if (err instanceof CommandExitError) {
      // Non-zero exit is the EXPECTED path when there are type errors —
      // the diagnostics are on stdout regardless of exit code.
      stdout = err.stdout;
    } else {
      // Sandbox unreachable, timed out, or tsc itself missing — don't block
      // the build on infrastructure trouble unrelated to the generated code,
      // but don't report it as a clean type check either: nothing was checked.
      return { ok: true, issues: [], unavailable: true };
    }
  }

  const issues: PreviewIssue[] = [];
  TSC_DIAGNOSTIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TSC_DIAGNOSTIC_RE.exec(stdout)) !== null) {
    const [, file, line, , code, text] = m;
    if (!file || !code || !text) continue;
    issues.push({ source: file, message: `${code}: ${text.trim()} (line ${line})` });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Headless-Chromium render check: loads the live Vite dev server INSIDE the
 * sandbox (localhost:5173 — never the external preview URL) and reports
 * console/page errors or an empty #root. Catches what verifyPreview() and
 * runTypeCheck() structurally cannot — a page that compiles clean and
 * type-checks clean but crashes or renders blank at runtime.
 *
 * check-render.mjs and its own Playwright install are baked into the image
 * at /home/user/.lampcode-tools (see template.ts) — deliberately outside the
 * generated app's own package.json/node_modules. No-op (ok:true) if no live
 * in-process sandbox exists, same silent-skip behavior as the other checks.
 */
export async function verifyBrowserRender(projectId: string): Promise<GateResult> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return skippedGate(projectId, "verifyBrowserRender");

  let stdout = "";
  try {
    const r = await sandbox.commands.run(
      `${TOOLS_ENV} node ${TOOLS_DIR}/check-render.mjs http://localhost:5173`,
      { timeoutMs: 30_000 },
    );
    stdout = r.stdout;
  } catch (err) {
    // Sandbox unreachable, timed out, or the check tooling itself missing —
    // don't block the build on infrastructure trouble unrelated to the
    // generated code (same policy as runTypeCheck's catch above), but the
    // page was never actually opened, so say so.
    //
    // Logged, not swallowed: this catch used to discard the error entirely,
    // so a browser check that kept failing across a whole session left no
    // trace of WHY — unreachable sandbox, missing script and timeout all
    // looked identical from outside.
    logger.warn(
      { projectId, err: err instanceof Error ? err.message : String(err) },
      "[e2b] verifyBrowserRender could not run",
    );
    return { ok: true, issues: [], unavailable: true };
  }

  let parsed: { ok: boolean; blank: boolean; errors: string[] };
  try {
    // The script prints exactly one JSON line on success or on its own
    // caught failure — but stdout could still have leading noise (e.g. an
    // npm/node warning), so parse the last line rather than the whole blob.
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    parsed = JSON.parse(lastLine);
  } catch {
    // Unparseable output — infra noise, not a real render failure. Nothing
    // was learned about the page either way. The head of stdout is logged
    // because what the script actually printed is the only clue to why.
    logger.warn(
      { projectId, stdoutHead: stdout.slice(0, 300) },
      "[e2b] verifyBrowserRender output could not be parsed",
    );
    return { ok: true, issues: [], unavailable: true };
  }

  if (parsed.ok) return { ok: true, issues: [] };

  // Vite's HMR client is configured for the EXTERNAL e2b.app preview domain,
  // but check-render.mjs opens the page on localhost INSIDE the sandbox, so its
  // websocket is always refused there. It says nothing about the generated app,
  // and on every build it made this gate report failure on a page that rendered
  // fine — costing a repair dispatch and inviting the model to change working
  // code to satisfy a complaint about the environment.
  //
  // Matched narrowly: a localhost websocket failure and Vite's own two
  // messages. An app's websocket to its real backend does not match.
  const HMR_NOISE = [
    /^WebSocket connection to 'wss?:\/\/localhost[:/][^']*' failed/i,
    /^\[vite\] failed to connect to websocket/i,
    /^Error: WebSocket closed without opened\.?$/i,
  ];
  const errors = parsed.errors.filter(
    (e) => !HMR_NOISE.some((re) => re.test(e.trim())),
  );

  // Nothing left but that noise, and the page did render — it passed.
  if (!parsed.blank && errors.length === 0) return { ok: true, issues: [] };

  const message = parsed.blank
    ? `The app rendered a blank page (#root has no children)${errors.length > 0 ? ": " + errors.join("; ") : ""}`
    : `Console errors on load: ${errors.join("; ")}`;
  return { ok: false, issues: [{ source: "src/App.tsx", message }] };
}

// ── Agent observation reads ─────────────────────────────────────────────────
// These exist so the model can investigate the project it is working on rather
// than guessing from whatever was inlined into its prompt.

/** `.env`, `.env.local`, `src/.env.production`, … at any depth. */
const SECRET_FILE_RE = /(^|\/)\.env(\.|$)/i;

/**
 * Validate a model-chosen path before it reaches the filesystem.
 *
 * Returns the cleaned project-relative path, or null to refuse. Two things are
 * refused: anything that could escape PROJECT_DIR (absolute paths, `..`), and
 * the preview env files. The env refusal is not about this project's own
 * secrets — it holds the shared preview Supabase and MongoDB credentials that
 * every generated app in the fleet uses. The agent never needs them: it writes
 * code that reads `import.meta.env.VITE_SUPABASE_URL` at runtime.
 */
function safeProjectPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.includes("..") || p.includes("\0")) return null;
  if (SECRET_FILE_RE.test(p)) return null;
  return p;
}

/** Read one project file out of the live sandbox. Throws with a readable reason. */
export async function readProjectFile(projectId: string, path: string): Promise<string> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) throw new Error("no live sandbox for this project");
  const safe = safeProjectPath(path);
  if (!safe) throw new Error(`refused to read "${path}"`);
  return sandbox.files.read(`${PROJECT_DIR}/${safe}`);
}

/** List the project's source files (excludes deps, build output and env files). */
export async function listProjectFiles(projectId: string): Promise<string[]> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) throw new Error("no live sandbox for this project");
  const r = await sandbox.commands.run(
    "find . -type f " +
      "-not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' " +
      "-not -path './.next/*' -not -name '.env*' | sed 's|^\\./||' | sort | head -400",
    { cwd: PROJECT_DIR, timeoutMs: 15_000 },
  );
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Recent dev-server and app-backend output for this project's sandbox.
 * Both are ring buffers captured as the processes run — nothing is re-executed.
 */
export function readSandboxLogs(projectId: string): { dev: string[]; backend: string[] } | null {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return null;
  return {
    dev: devLogs.get(sandbox.sandboxId) ?? [],
    backend: backendLogs.get(sandbox.sandboxId) ?? [],
  };
}

/** Whether a live, in-process sandbox is currently held for this project. */
export function hasSandbox(projectId: string): boolean {
  return sandboxes.has(projectId);
}

/**
 * Whether this project has ANY sandbox record (live in-process OR a paused
 * snapshot saved in Redis). Used to route follow-up edits of a fullstack
 * project back to the E2B preview instead of falling through to Sandpack.
 */
export async function hasSandboxRecord(projectId: string): Promise<boolean> {
  if (sandboxes.has(projectId)) return true;
  try {
    return (await loadSandboxId(projectId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Resumes (or, failing that, creates) a running sandbox for the project and
 * makes sure its Vite dev server is up — WITHOUT writing any app files. The
 * template already ships a baked baseline scaffold, so a fresh sandbox serves a
 * "Loading…" page immediately; the real files are streamed in later via HMR.
 * Registers the sandbox in the in-process map and Redis.
 */
async function acquireRunningSandbox(
  projectId: string,
  log: PreviewLogCallback,
  framework: FullstackFramework = "react",
): Promise<Sandbox> {
  const savedSandboxId = await loadSandboxId(projectId);
  if (savedSandboxId) {
    const resumed = await tryResumeSandbox(projectId, savedSandboxId);
    if (resumed) {
      sandboxes.set(projectId, resumed);
      sandboxFrameworks.set(projectId, framework);
      // A resumed snapshot's dev server may not have survived the pause —
      // verify and restart it if needed rather than assuming.
      await ensureDevServer(resumed, log, framework);
      log("Resumed existing sandbox");
      return resumed;
    }
  }

  log("Creating fresh sandbox from template...");
  const sandbox = await Sandbox.create(selectTemplate(framework), {
    ...(config.E2B_API_KEY ? { apiKey: config.E2B_API_KEY } : {}),
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  console.log("[E2B] Sandbox created (prewarm):", sandbox.sandboxId);
  sandboxes.set(projectId, sandbox);
  sandboxFrameworks.set(projectId, framework);
  await saveSandboxId(projectId, sandbox.sandboxId, framework);

  try {
    // Inject preview env BEFORE the dev server boots (env is only read at startup).
    await writePreviewEnv(sandbox, projectId, log);
    await patchSandboxTsconfig(sandbox, log);
    await patchSandboxTypeShims(sandbox, log);
    // Baked scaffold already has node_modules — this is just dev-server startup.
    const devLog = makeDevLog(log, sandbox.sandboxId);
    await startDevServer(sandbox, devLog.log, framework);
    const ready = await waitForServerReady(previewUrlFor(sandbox, framework), framework);
    if (!ready) {
      const diag = await fetchDevServerDiag(sandbox, framework, devLog.last());
      throw new Error(`Prewarmed sandbox dev server did not become ready within ${readyPollTimeoutMs(framework) / 1000}s. ${diag}`);
    }
    return sandbox;
  } catch (err) {
    // Don't leave a dead sandbox registered as "live" — the completion path
    // would reuse it and hand the client a broken preview URL. Clean up fully
    // so it does a fresh cold start instead.
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    await deleteSandboxId(projectId).catch(() => {});
    await sandbox.kill().catch(() => {});
    throw err;
  }
}

/**
 * Kicks off sandbox boot in the BACKGROUND at build start so it warms up in
 * parallel with AI code generation (the "ensure sandbox first" pattern). By the
 * time files are ready, Vite is already running and we only stream the files in.
 * Idempotent: a no-op if the sandbox is already live or already warming.
 */
export function prewarmSandbox(projectId: string, framework: FullstackFramework = "react", onLog?: PreviewLogCallback): void {
  if (!config.E2B_API_KEY) return;
  if (sandboxes.has(projectId) || warmingSandboxes.has(projectId)) return;

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b:prewarm]");
  };

  const promise = acquireRunningSandbox(projectId, log, framework)
    .catch((err) => {
      // Don't let a prewarm failure kill anything — the complete path will
      // fall back to a full create. Just surface it and clear the entry.
      logger.warn({ projectId, err }, "[e2b] prewarm failed (will cold-start on complete)");
      throw err;
    })
    .finally(() => {
      warmingSandboxes.delete(projectId);
    });

  warmingSandboxes.set(projectId, promise);
  void promise.catch(() => {});
}

/** Awaits an in-flight prewarm (if any) so we never race into a 2nd sandbox. */
async function awaitWarming(projectId: string): Promise<void> {
  const warming = warmingSandboxes.get(projectId);
  if (warming) {
    try {
      await warming;
    } catch (err) {
      // prewarm failed — fall through; caller's own create path handles it.
      // Logged (was previously silent) so a stuck/failed prewarm is visible
      // in Railway logs instead of looking like an unexplained hang.
      logger.warn({ projectId, err }, "[e2b] awaited prewarm failed");
    }
  }
}

/**
 * Pushes new files straight into a project's already-running sandbox and
 * returns its preview URL — no install, no dev-server (re)start, no
 * readiness poll. Used for follow-up builds: Vite's HMR picks up the file
 * changes and refreshes the preview automatically.
 *
 * Throws if no live sandbox is held for the project — callers should guard
 * with `hasSandbox(projectId)` first.
 */
export async function writeFilesToSandbox(
  projectId: string,
  files: Record<string, string>,
  onLog?: PreviewLogCallback,
): Promise<string> {
  await awaitWarming(projectId);
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) {
    throw new Error(`No live E2B sandbox for project ${projectId}`);
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b]");
  };

  const framework = sandboxFrameworks.get(projectId) ?? "react";
  patchViteConfig(files, log);
  patchEntryStylesheet(files, log);
  // Heartbeat: every follow-up write extends the sandbox lifetime so an
  // actively-used session never hits the timeout set at create/resume.
  await sandbox.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
  await writeFiles(sandbox, files, log);
  // Before ensureDevServer, which is what makes this safe: on a follow-up the
  // dev server may already be running, and installing underneath a live one is
  // exactly what broke previews before. ensureDevServer restarts it if the
  // install disturbed it, so new deps are picked up either way.
  await installExtraDependencies(sandbox, files, log);
  await patchSandboxTsconfig(sandbox, log);
  await patchSandboxTypeShims(sandbox, log);
  await ensureDevServer(sandbox, log, framework);
  const url = previewUrlFor(sandbox, framework);
  log(`Preview updated at ${url} (HMR will refresh automatically)`);
  return url;
}

/**
 * Resume-on-open: when a user re-opens a project (no new build), bring its
 * preview back to life and return a FRESH URL. Resume-only — it never creates a
 * brand-new sandbox, because a fresh sandbox wouldn't contain the user's
 * generated files (those live in the paused snapshot). Returns null when there
 * is nothing to resume (no prior build, or the snapshot expired) so the caller
 * simply leaves the preview as-is until the next build.
 */
/**
 * Bring a project's preview back when there is nothing left to resume.
 *
 * ensurePreviewForProject is resume-only by design and returns null once E2B
 * has reclaimed the sandbox — which is what a user hits whenever they close
 * the tab and come back later. Nothing downstream distinguished that from "no
 * preview exists", so the client was left on a dead pane with no explanation.
 *
 * This rebuilds from the files already in storage: a cold sandbox written with
 * the project as it was last saved. Deliberately NOT called on open — it costs
 * a fresh sandbox every time, so it runs only when the user asks for it.
 *
 * Returns null if the project has no stored files, i.e. there is genuinely
 * nothing to restore, which the caller should say rather than retry.
 */
export async function restorePreviewForProject(
  projectId: string,
  sessionId: string,
  onLog?: PreviewLogCallback,
): Promise<string | null> {
  if (!config.E2B_API_KEY) return null;

  // A sandbox that is still alive or still resumable beats rebuilding one.
  const existing = await ensurePreviewForProject(projectId, onLog);
  if (existing) return existing;

  let files: Record<string, string>;
  try {
    files = await downloadProjectFiles(projectId);
  } catch (err) {
    logger.warn({ projectId, err }, "[e2b] restore: could not read stored project files");
    throw new Error("the saved project files could not be read");
  }

  const count = Object.keys(files).length;
  if (count === 0) {
    logger.info({ projectId }, "[e2b] restore: project has no stored files");
    return null;
  }

  // createPreviewSandbox, NOT writeFilesToSandbox: the latter requires a live
  // sandbox and throws "No live E2B sandbox" when there is none, which is
  // exactly the case this function exists to handle. It did, in production.
  const framework = (await loadFramework(projectId)) ?? "react";
  onLog?.(`Restoring preview from ${count} saved file(s)...`);
  logger.info({ projectId, count, framework }, "[e2b] restore: rebuilding sandbox from stored files");
  return await createPreviewSandbox(sessionId, projectId, framework, files, onLog);
}

export async function ensurePreviewForProject(
  projectId: string,
  onLog?: PreviewLogCallback,
): Promise<string | null> {
  if (!config.E2B_API_KEY) return null;

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ projectId, line }, "[e2b:resume-on-open]");
  };

  await awaitWarming(projectId);

  // Already live in this process — just make sure the dev server is up.
  const live = sandboxes.get(projectId);
  if (live) {
    const framework = sandboxFrameworks.get(projectId) ?? "react";
    try {
      await ensureDevServer(live, log, framework);
      await live.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
      return previewUrlFor(live, framework);
    } catch {
      // live ref is dead — drop it and try to resume the snapshot below.
      sandboxes.delete(projectId);
      sandboxFrameworks.delete(projectId);
    }
  }

  const savedId = await loadSandboxId(projectId);
  if (!savedId) return null; // never built / snapshot gone — nothing to resume.

  // Load the framework from Redis so the correct port (3000 vs 5173) is used
  // after a server restart when the in-memory sandboxFrameworks map is empty.
  const persistedFramework = await loadFramework(projectId);

  let warm = warmingSandboxes.get(projectId);
  if (!warm) {
    warm = (async () => {
      const resumed = await tryResumeSandbox(projectId, savedId);
      if (!resumed) throw new Error("resume-on-open: snapshot unavailable");
      sandboxes.set(projectId, resumed);
      const framework = sandboxFrameworks.get(projectId) ?? persistedFramework ?? "react";
      sandboxFrameworks.set(projectId, framework);
      await ensureDevServer(resumed, log, framework);
      return resumed;
    })().finally(() => warmingSandboxes.delete(projectId));
    warmingSandboxes.set(projectId, warm);
  }

  try {
    const sb = await warm;
    await sb.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
    const framework = sandboxFrameworks.get(projectId) ?? "react";
    return previewUrlFor(sb, framework);
  } catch (err) {
    logger.warn({ projectId, err }, "[e2b] resume-on-open failed — preview needs a rebuild");
    return null;
  }
}

/**
 * Returns the live preview URL for a project's sandbox, creating, resuming,
 * or reusing one as needed (the "Lovable" get-or-create pattern):
 *
 *   1. Already running in this process?  → write files, verify Vite, return URL.
 *   2. A prewarm/acquire in flight?       → await the SAME promise (no 2nd sandbox).
 *   3. Otherwise → acquireRunningSandbox: resume the paused snapshot or create
 *      fresh from TEMPLATE_ID, inject preview env, start Vite, wait until ready.
 *
 * Every turn refreshes the sandbox lifetime (setTimeout heartbeat).
 * Never kills an existing sandbox — reuse, not replace.
 */
export async function createPreviewSandbox(
  sessionId: string,
  projectId: string,
  framework: FullstackFramework,
  files: Record<string, string>,
  onLog?: PreviewLogCallback,
): Promise<string> {
  console.log("[E2B] Starting sandbox creation for session:", sessionId, "project:", projectId);
  console.log("[E2B] API key present:", !!config.E2B_API_KEY);
  console.log("[E2B] File count:", Object.keys(files).length);

  if (!config.E2B_API_KEY) {
    console.error("[E2B] E2B_API_KEY is not configured — cannot start preview sandbox");
    throw new Error("E2B_API_KEY is not configured on the server");
  }

  const log = (line: string): void => {
    onLog?.(line);
    logger.debug({ sessionId, projectId, line }, "[e2b]");
  };

  patchViteConfig(files, log);
  patchEntryStylesheet(files, log);

  let sandbox: Sandbox | undefined;
  try {
    // ── Acquire (race-proof): live → in-flight warm → resume-or-create ──────
    // All acquisition funnels through the warmingSandboxes promise-cache, so
    // concurrent callers (prewarm vs completion, double builds) always share
    // ONE sandbox instead of leaking a second one.
    await awaitWarming(projectId);
    sandbox = sandboxes.get(projectId);
    if (sandbox) {
      console.log("[E2B] Reusing live in-process sandbox for project:", projectId);
    } else {
      let warm = warmingSandboxes.get(projectId);
      if (!warm) {
        warm = acquireRunningSandbox(projectId, log, framework).finally(() => {
          warmingSandboxes.delete(projectId);
        });
        warmingSandboxes.set(projectId, warm);
      }
      sandbox = await warm;
    }

    // Each build turn extends the sandbox lifetime — a long iterate session
    // must not die at the timeout set when the sandbox was first created.
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});

    await writeFiles(sandbox, files, log);
    // Same ordering as the follow-up write path: install before the dev server
    // is (re)started, never underneath a running one.
    await installExtraDependencies(sandbox, files, log);
    await patchSandboxTsconfig(sandbox, log);
    await patchSandboxTypeShims(sandbox, log);
    await ensureDevServer(sandbox, log, framework);

    const url = previewUrlFor(sandbox, framework);
    console.log("[E2B] Dev server is ready:", url);
    log(`Preview ready at ${url}`);
    return url;
  } catch (err) {
    console.error("[E2B] FULL ERROR:", err);
    console.error("[E2B] Error name:", err instanceof Error ? err.name : typeof err);
    console.error("[E2B] Error message:", err instanceof Error ? err.message : String(err));
    console.error("[E2B] Error stack:", err instanceof Error ? err.stack : undefined);
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    await sandbox?.kill().catch(() => {});
    throw err;
  }
}

/**
 * Pauses a project's sandbox: snapshots its state on E2B's side and drops the
 * in-process reference, but keeps the Redis record (the saved sandboxId is
 * exactly what `createPreviewSandbox` needs to resume it later). No-op if no
 * live sandbox is held in this process.
 */
export async function pauseSandbox(projectId: string): Promise<void> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return;

  try {
    await sandbox.pause();
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    console.log("[E2B] Paused sandbox for project:", projectId);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to pause sandbox");
    throw err;
  }
}

/**
 * Tears down the sandbox for a project entirely — removes both the in-process
 * reference and the Redis record (unlike pause, there is nothing to resume
 * afterwards). Use only on project delete or explicit user cancel; never on
 * follow-up builds — those should reuse the existing sandbox.
 */
export async function killSandbox(projectId: string): Promise<void> {
  try {
    const existing = sandboxes.get(projectId);
    sandboxes.delete(projectId);
    sandboxFrameworks.delete(projectId);
    if (existing) {
      await existing.kill().catch((err) => {
        logger.warn({ projectId, err }, "Failed to kill E2B sandbox");
      });
    }
    await deleteSandboxId(projectId);
  } catch (err) {
    logger.error({ projectId, err }, "[e2b] Failed to kill sandbox");
    throw err;
  }
}

/**
 * Tears down every active in-process sandbox. Used on process shutdown
 * (SIGTERM) so we don't leak running E2B VMs when the server restarts/
 * redeploys — without this, sandboxes only die via their own 30-minute idle
 * timeout on E2B's side.
 */
export async function killAllSandboxes(): Promise<void> {
  const projectIds = [...sandboxes.keys()];
  if (projectIds.length === 0) return;
  logger.info({ count: projectIds.length }, "Killing all active E2B sandboxes");
  await Promise.all(projectIds.map((projectId) => killSandbox(projectId)));
}

/**
 * Capture a screenshot of the running preview, for the project card thumbnail.
 *
 * Playwright and Chromium are already baked into the template (they back
 * verifyBrowserRender), so this writes a tiny capture script into /tmp at
 * runtime rather than requiring a template rebuild. The PNG comes back as
 * base64 through stdout because that is the one channel guaranteed to work for
 * binary data across the sandbox boundary without a second round trip.
 *
 * Returns null on any failure. A missing thumbnail is a cosmetic gap; it must
 * never fail a build that otherwise succeeded — same policy as the other
 * sandbox-side gates.
 */
export async function capturePreviewScreenshot(projectId: string): Promise<Buffer | null> {
  const sandbox = sandboxes.get(projectId);
  if (!sandbox) return null;

  const framework = sandboxFrameworks.get(projectId) ?? "react";
  const port = devPort(framework);
  const script = `
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await p.goto("http://localhost:${port}", { waitUntil: "networkidle", timeout: 20000 });
} catch {}
await p.waitForTimeout(1200);
const buf = await p.screenshot({ type: "png" });
await b.close();
process.stdout.write("B64:" + buf.toString("base64"));
`;

  try {
    await sandbox.files.write(`${TOOLS_DIR}/lampcode-shot.mjs`, script);
    const r = await sandbox.commands.run(
      `${TOOLS_ENV} node ${TOOLS_DIR}/lampcode-shot.mjs`,
      { timeoutMs: 45_000 },
    );
    const marker = r.stdout.indexOf("B64:");
    if (marker === -1) return null;
    const b64 = r.stdout.slice(marker + 4).trim();
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    // A PNG under ~1KB is a blank or failed render, not a screenshot worth showing.
    return buf.length > 1024 ? buf : null;
  } catch (err) {
    logger.warn({ projectId, err }, "[e2b] preview screenshot failed");
    return null;
  }
}
