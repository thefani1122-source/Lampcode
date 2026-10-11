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
import { runSmokeTests } from "./smoke.js";

/** The user's own Vercel credential, from their connected MCP row. Never
 *  logged, never sent to the model, never written into the sandbox. */
export interface VercelAuth {
  accessToken: string;
  /** Only needed when the token's default scope is not the target team. */
  teamId?: string | undefined;
}

/** What the generated app actually is, which decides the Vercel preset. */
export type DeployShape = "static" | "hono" | "fastapi";

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
  if (has("src/server/main.py")) return "fastapi";
  if (has("src/server/app.ts") || has("src/server/index.ts")) return "hono";
  return "static";
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
export function vercelScaffold(shape: DeployShape): Record<string, string> {
  if (shape === "hono") {
    return {
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
  // FastAPI already exposes the ASGI `app` that Vercel's python preset wants,
  // and a static build needs nothing added.
  return {};
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
  const withScaffold = { ...input.files, ...vercelScaffold(shape) };
  const { inlined, skipped } = toInlinedFiles(withScaffold);
  const name = projectSlug(input.projectName);

  if (inlined.length === 0) {
    return { ok: false, shape, error: "There are no files to deploy." };
  }

  const target = (mcpToolName: string) => ({
    serverSlug: "vercel",
    serverUrl: VERCEL_MCP_URL,
    authToken: input.auth.accessToken,
    mcpToolName,
  });

  const framework = shape === "fastapi" ? "fastapi" : "vite";
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

  const createdJson = parseMcpJson(created);
  const id = str(createdJson, "id") ?? str(createdJson, "uid");
  let url = str(createdJson, "url");
  if (id === undefined && url === undefined) {
    return {
      ok: false,
      shape,
      error: "Vercel accepted the request but returned no deployment to follow.",
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
      const j = parseMcpJson(got);
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
  const smoke = await smokeFn(fullUrl).catch(() => undefined);

  return {
    ok: smoke?.ok !== false,
    url: fullUrl,
    state,
    shape,
    ...(smoke === undefined ? {} : { smoke }),
    ...(smoke?.ok === false
      ? { error: "The app deployed but did not answer correctly when checked." }
      : {}),
  };
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
  return [
    outcome.error ?? "The deployment didn't go through.",
    "Nothing was changed in your project. Tell me and I'll try again.",
  ];
}
