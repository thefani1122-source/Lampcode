/**
 * What the app actually shows, on every page it declares — not just `/`.
 *
 * The check this replaces opened one URL and answered one question: did it
 * crash. It returned a single sentence, and that sentence is all the model has
 * ever seen of its own work. Two measured failures come straight out of that:
 *
 *   ROTA (2026-10-07) shipped a dashboard reading "No shifts scheduled" while
 *   four requested views were never imported. check_page said **pass** — truly,
 *   because `#root` had children and the console was quiet. Correct, and
 *   useless. The rendered TEXT would have said so in four words.
 *
 *   And the owner's standing complaint, that pages in a multi-page app do
 *   nothing: the harness never opened those pages. `/` was the only URL it
 *   ever visited, so every other route was unobserved by construction.
 *
 * So this collects the same crash signals for EVERY declared route, plus the
 * text each one renders. The text is the part that answers "is this actually
 * the app the user asked for", which no error count can.
 *
 * ## What it costs in time — measured, not assumed
 *
 * Against a real four-page site: old check, one route, 1.88s. This one, one
 * route, 1.70s; four routes, 4.56s; eight routes, 8.31s. So roughly 1.7s to
 * start and ~0.95s per extra page, most of it the settle wait that lets async
 * errors surface.
 *
 * It is therefore NOT free, and an earlier claim here that more routes would
 * somehow beat one route was simply wrong. What it is, is about half what the
 * naive version would cost — launching a browser per route would be ~1.9s
 * EACH — and the thing being bought is the only evidence anyone has ever had
 * about the pages after the first.
 *
 * ## What actually costs money
 *
 * Not the browser — the sandbox is already running and nobody is billed for a
 * page load. The cost is TOKENS: whatever this returns is appended to the
 * model's context and paid for again on every subsequent round. That is why
 * the formatter below is miserly by default and verbose only where something
 * is wrong, and why `formatRenderForAgent` takes the previous result: a
 * re-check of an app that has not changed should cost almost nothing.
 */

/** Objective layout facts collected in a real browser at one viewport. */
export type ViewportLayout = {
  width: number;
  height: number;
  scrollWidth: number;
  horizontalOverflow: number;
  mainCount: number;
  navCount: number;
  asideCount: number;
  headingCount: number;
  passwordFormWidth: number | null;
  bodyFontFamily: string;
  bodyBackground: string;
};

/** One route, as the browser found it. */
export type RouteRender = {
  route: string;
  /** Nothing wrong was observed: not blank, no errors, no overlay. */
  ok: boolean;
  /** `#root` exists but has no children — the page is structurally empty. */
  blank: boolean;
  /** Console errors and uncaught exceptions, HMR noise already removed. */
  errors: string[];
  /** Vite's error overlay text, which never reaches the console. */
  overlay?: string;
  /** Requests the page made that came back 4xx/5xx, cosmetic assets removed. */
  failedRequests: { url: string; status: number }[];
  /** What the page actually says, trimmed and capped. */
  text: string;
  /** Visible first-run empty-state copy that should have been populated with sample data. */
  emptyState?: string;
  /** A collection-based product rendered only a shell instead of a usable workspace. */
  contentIssue?: string;
  /** Browser-measured layout at desktop and mobile widths. */
  layout?: { desktop?: ViewportLayout; mobile?: ViewportLayout };
  /** Objective responsive/auth-layout defects; subjective aesthetics remain a separate review. */
  layoutIssues?: string[];
};

export type RenderReport = {
  routes: RouteRender[];
  /** A route was declared but the browser could not be driven to it at all. */
  unreachable: string[];
};

/**
 * Vite's HMR client is configured for the EXTERNAL e2b.app preview domain, but
 * this script opens pages on localhost INSIDE the sandbox, so its websocket is
 * always refused there. It says nothing about the generated app, and left in it
 * made the old gate report failure on pages that rendered fine — costing a
 * repair dispatch and inviting the model to change working code to satisfy a
 * complaint about the environment.
 *
 * Matched narrowly, exactly as e2b-service.ts matches it: a localhost websocket
 * failure and Vite's own two messages. An app's websocket to its real backend
 * does not match.
 */
const HMR_NOISE = [
  /^WebSocket connection to 'wss?:\/\/localhost[:/][^']*' failed/i,
  /^\[vite\] failed to connect to websocket/i,
  /^Error: WebSocket closed without opened\.?$/i,
];

/**
 * The console's own line for a failed request, which is pure noise HERE because
 * the response listener records the same event with its URL and status. Found
 * by running this against a real page: a missing favicon produced exactly this
 * message, which would have marked every page of every app as broken.
 */
const GENERIC_RESOURCE_ERROR = /^Failed to load resource:/i;

function isHmrNoise(message: string): boolean {
  const m = message.trim();
  return HMR_NOISE.some((re) => re.test(m)) || GENERIC_RESOURCE_ERROR.test(m);
}

/**
 * Assets whose absence is cosmetic and never means the app is broken.
 *
 * A generated app almost never ships a favicon, so without this every single
 * page would be reported as failing — a false accusation that costs a repair
 * dispatch and teaches the model to "fix" working code. Everything else that
 * comes back 4xx/5xx is kept, because in a generated app a failing request to
 * its own backend IS the feature not working, and that is precisely the
 * complaint this check exists to surface.
 */
const COSMETIC_ASSET = /\/(favicon\.\w+|apple-touch-icon[^/]*\.png|site\.webmanifest|manifest\.json|robots\.txt)(\?|$)/i;

/** How much of a page's text is worth carrying back. See the cost note above. */
export const MAX_TEXT_CHARS = 400;

/**
 * First-run empty-state copy that indicates a new frontend/mock app failed to
 * initialise its requested sample content. Kept outside the browser script so
 * the exact detector can be regression-tested without launching Chromium.
 */
export const INITIAL_EMPTY_STATE_RE =
  /\b(?:no (?:habits?|tasks?|items?|entries|records?|data|events?|orders?|customers?|projects?|notes?|shifts?|transactions?|messages?)\s+yet|nothing (?:here|to show|to display) yet|create your first (?:habit|task|item|entry|record|event|order|customer|project|note|shift|transaction|message)|add your first (?:habit|task|item|entry|record|event|order|customer|project|note|shift|transaction|message))\b/i;

/**
 * Whether a first-run frontend should be expected to contain seeded content.
 * Kept pure so the initial agentic sweep and the post-repair freshness check
 * cannot quietly apply different acceptance rules to the same build.
 */
export function shouldRequireInitialContent(opts: {
  agentType: string;
  taskDescription: string;
  userPrompt?: string | undefined;
  projectFiles?: Record<string, string> | undefined;
}): boolean {
  const isFullstackBuild =
    opts.taskDescription.startsWith("FULLSTACK BUILD:") ||
    opts.taskDescription.startsWith("FULLSTACK AUTH BUILD:");
  const existingProjectHasBackend = Object.keys(opts.projectFiles ?? {}).some((path) =>
    /(^|\/)(?:server|backend|api|db|database)(?:\/|\.|$)/i.test(path),
  );
  const originalUserRequest = opts.userPrompt ?? opts.taskDescription;
  const explicitlyRequestsEmptyFirstRun =
    /\bno sample data\b|\b(?:first|initial|default|start|begin|launch|open)\b.{0,45}\b(?:empty|blank)\b|\b(?:empty|blank)\b.{0,45}\b(?:first|initial|default|start|begin|launch)\b/i.test(
      originalUserRequest,
    );

  // This policy concerns seeded RECORDS only. A full-stack app may have a
  // genuinely empty database, and an explicit no-sample-data request must be
  // respected. Workspace completeness is checked separately below.
  return opts.agentType === "frontend" &&
    !isFullstackBuild &&
    !existingProjectHasBackend &&
    !explicitlyRequestsEmptyFirstRun;
}

const COLLECTION_SURFACE_PROMPT_RE =
  /\b(?:habits?|tasks?|to[ -]?do|trackers?|dashboards?|managers?|management|catalogs?|crm|inventory|kanban|calendars?|schedulers?|shift planners?|rosters?|expenses?|budgets?|invoices?|orders?|products?|customers?|clients?|contacts?|projects?|employees?|staff|bookings?|events?|transactions?|subscriptions?)\b/i;

const COLLECTION_SURFACE_EXEMPT_RE =
  /\b(?:blank|empty)\s+(?:starter|template|canvas)|(?:starter|template|canvas)\s+(?:blank|empty)|wireframe(?:\s+only)?|mock[- ]?up\s+only|static\s+prototype\s+only\b/i;

/**
 * Whether this build promises a real collection/workspace UI, independently
 * from whether its first-run data should be seeded. A live database may contain
 * zero rows, but that does not justify shipping only a heading and one button.
 */
export function shouldRequireCollectionSurface(opts: {
  agentType: string;
  taskDescription: string;
  userPrompt?: string | undefined;
}): boolean {
  if (opts.agentType !== "frontend") return false;
  const request = opts.userPrompt ?? opts.taskDescription;
  return COLLECTION_SURFACE_PROMPT_RE.test(request) &&
    !COLLECTION_SURFACE_EXEMPT_RE.test(request);
}

const CORE_JOURNEY_PROMPT_RE =
  /\\b(?:habits?|tasks?|to[ -]?do|trackers?|kanban|calendars?|schedulers?|shift planners?|rosters?|crm|inventory|expenses?|budgets?|invoices?|orders?|products?|customers?|clients?|contacts?|projects?|employees?|staff|bookings?|events?|transactions?|subscriptions?)\\b/i;

/** Products with a primary create/update/complete workflow need a real browser journey, not click-only evidence. */
export function shouldRequireCoreJourney(opts: {
  agentType: string;
  taskDescription: string;
  userPrompt?: string | undefined;
}): boolean {
  if (opts.agentType !== "frontend") return false;
  // browser_interact can create/complete records. Never make that a mandatory
  // side effect against a live user-owned database without an isolated test tenant.
  if (/^(?:FULLSTACK BUILD:|FULLSTACK AUTH BUILD:|EXISTING FULLSTACK EDIT:)/i.test(opts.taskDescription)) return false;
  const request = opts.userPrompt ?? opts.taskDescription;
  return CORE_JOURNEY_PROMPT_RE.test(request) &&
    !COLLECTION_SURFACE_EXEMPT_RE.test(request);
}

/**
 * Routes to visit, from the project's own files.
 *
 * `/` is always included and always first: it is the one route every app has,
 * and if it is broken nothing else matters. The rest come from whatever the
 * code declares, which is the same source `wiring.ts` uses to decide whether a
 * link points anywhere real — so the two agree by construction.
 *
 * Parameterised routes are dropped rather than guessed. Visiting `/shift/:id`
 * literally lands on a page with no such record and reports an empty state as
 * a failure, which is a false accusation, and inventing an id would be worse.
 */
export function routesToVisit(declared: string[]): string[] {
  const out = new Set<string>(["/"]);
  for (const r of declared) {
    if (!r.startsWith("/")) continue;
    if (r.includes(":") || r.includes("*")) continue;
    out.add(r);
  }
  return [...out];
}

/**
 * The script, written into the sandbox at runtime and run with the baked
 * Playwright.
 *
 * Deliberately NOT baked into the template image. `check-render.mjs` is, and
 * changing it means a template rebuild — where a failed build silently leaves
 * the last good image serving, which is how check_page stayed broken for three
 * weeks. A runtime write has no such failure mode: it either lands or the run
 * errors out loud. Same pattern as `lampcode-interact.mjs`.
 */
export const RENDER_SCRIPT = String.raw`import { chromium } from "playwright"
import { readFile } from "node:fs/promises"

const MAX_TEXT = ${MAX_TEXT_CHARS}
const INITIAL_EMPTY_STATE_RE = new RegExp(${JSON.stringify(INITIAL_EMPTY_STATE_RE.source)}, "i")
let base = "http://localhost:5173"
let routes = ["/"]
let REQUIRE_INITIAL_CONTENT = true
let REQUIRE_COLLECTION_SURFACE = false

const out = { routes: [], unreachable: [] }
let browser

try {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"))
  if (typeof input.base === "string") base = input.base
  if (Array.isArray(input.routes)) routes = input.routes
  REQUIRE_INITIAL_CONTENT = input.requireInitialContent !== false
  REQUIRE_COLLECTION_SURFACE = input.requireCollectionSurface === true

  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })

  // Record objective layout facts: these cannot judge visual taste, but they
  // catch mobile overflow and full-width authentication forms that DOM text
  // checks never see.
  const inspectLayout = () => page.evaluate(() => {
    const password = document.querySelector('input[type="password"]')
    const form = password ? (password.closest("form") || password) : null
    const formWidth = form ? Math.round(form.getBoundingClientRect().width) : null
    const bodyStyle = getComputedStyle(document.body)
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      mainCount: document.querySelectorAll("main").length,
      navCount: document.querySelectorAll("nav").length,
      asideCount: document.querySelectorAll("aside").length,
      headingCount: document.querySelectorAll("h1").length,
      passwordFormWidth: formWidth,
      bodyFontFamily: bodyStyle.fontFamily.slice(0, 120),
      bodyBackground: bodyStyle.backgroundColor,
    }
  })

  // Collected per navigation: reset before each goto so one broken route does
  // not smear its errors across every route checked after it.
  let errors = []
  let failedRequests = []
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()) })
  page.on("pageerror", (err) => errors.push(String(err)))
  // Watched separately from the console because the console's own message for
  // a failed request is the useless "Failed to load resource: the server
  // responded with a status of 404" -- no URL, no method. Here the URL and
  // status are both available, which turns an unactionable line into "GET
  // /api/shifts returned 500": the single most useful thing this check can
  // tell a model about an app whose buttons appear to do nothing.
  page.on("response", (res) => {
    const status = res.status()
    if (status >= 400) failedRequests.push({ url: res.url(), status })
  })

  for (const route of routes) {
    errors = []
    failedRequests = []
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(base + route, { waitUntil: "networkidle", timeout: 12000 })
      await page.waitForTimeout(400) // let async errors surface after load

      const blank = await page.evaluate(() => {
        const root = document.getElementById("root")
        return !!root && root.children.length === 0
      })

      // Vite's error overlay is a CUSTOM ELEMENT on document.body, not a child
      // of #root, and a module-resolution failure never reaches the console --
      // so neither of the checks above can see it. Its message text is the one
      // string that says what to fix.
      const overlay = await page.evaluate(() => {
        const el = document.querySelector("vite-error-overlay")
        if (!el) return null
        const text = (el.shadowRoot ? el.shadowRoot.textContent : el.textContent) || ""
        return text.replace(/\s+/g, " ").trim().slice(0, 500)
      })

      const pageContent = await page.evaluate((cap, emptyStatePattern, requireInitialContent, requireCollectionSurface) => {
        const body = document.body
        const fullText = (body?.innerText || "").replace(/\s+/g, " ").trim()
        const emptyState = requireInitialContent
          ? fullText.match(new RegExp(emptyStatePattern, "i"))?.[0] || null
          : null

        // Measure the primary workspace, not just the whole document. A real
        // backend can return zero records, but the app must still render its
        // summary, list/table container, guidance and useful empty-state actions.
        const root = document.getElementById("root")
        const surface = document.querySelector("main, [role=main]") || root || body
        const visible = (el) => {
          const style = getComputedStyle(el)
          return style.display !== "none" && style.visibility !== "hidden" &&
            Number(style.opacity) !== 0 && el.getClientRects().length > 0
        }
        const surfaceText = (surface?.innerText || "").replace(/\s+/g, " ").trim()
        const semanticBlocks = surface
          ? [...surface.querySelectorAll("section, article, table, ul, ol, form, [role=list], [role=grid], [role=table]")]
              .filter(visible).length
          : 0
        const headings = surface
          ? [...surface.querySelectorAll("h1, h2, h3")].filter(visible).length
          : 0
        const candidates = surface
          ? [surface, ...surface.querySelectorAll("div, section, article, main, ul, ol, table, form")]
          : []
        let meaningfulGroups = 0
        for (const node of candidates) {
          const count = [...node.children].filter((child) =>
            visible(child) && (child.innerText || "").replace(/\s+/g, " ").trim().length >= 12
          ).length
          meaningfulGroups = Math.max(meaningfulGroups, count)
        }
        const hasWorkspaceContent = surfaceText.length >= 90 &&
          (semanticBlocks > 0 || meaningfulGroups >= 2 || headings >= 3)
        const contentIssue = requireCollectionSurface && !hasWorkspaceContent
          ? "The collection product is only a shell: the primary workspace has " +
            surfaceText.length + " text characters, " + semanticBlocks +
            " semantic content block(s), " + meaningfulGroups +
            " meaningful content group(s), and " + headings +
            " heading(s). Build the actual dashboard/list/table/progress surface and a useful empty-data state. Do not invent rows in a real database."
          : null

        return {
          text: fullText.slice(0, cap),
          emptyState,
          contentIssue,
        }
      }, MAX_TEXT, INITIAL_EMPTY_STATE_RE.source, REQUIRE_INITIAL_CONTENT, REQUIRE_COLLECTION_SURFACE)

      const desktopLayout = await inspectLayout()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(120)
      const mobileLayout = await inspectLayout()
      await page.setViewportSize({ width: 1440, height: 900 })

      out.routes.push({
        route,
        blank,
        overlay: overlay || undefined,
        errors,
        failedRequests,
        text: pageContent.text,
        emptyState: pageContent.emptyState || undefined,
        contentIssue: pageContent.contentIssue || undefined,
        layout: { desktop: desktopLayout, mobile: mobileLayout },
      })
    } catch (err) {
      out.unreachable.push(route)
    }
  }
} catch (err) {
  out.fatal = String(err)
} finally {
  if (browser) { try { await browser.close() } catch {} }
}

console.log("LAMPCODE_RENDER:" + JSON.stringify(out))
`;

/**
 * Read the script's one marked line.
 *
 * Marked rather than "the last line" because this runs in a sandbox where npm
 * and node are free to print whatever they like, before or after. The old
 * check parsed the last line and a single trailing warning would have made a
 * working page look unverifiable.
 *
 * Returns null when nothing parseable was produced — the caller must report
 * that as "could not check", never as a pass. Saying the pages rendered fine
 * when the browser never opened them is how an agent ships a blank app while
 * believing it verified one.
 */
export function parseRenderReport(stdout: string): RenderReport | null {
  const marker = "LAMPCODE_RENDER:";
  const line = stdout.split("\n").reverse().find((l) => l.includes(marker));
  if (!line) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim());
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const o = raw as Record<string, unknown>;
  const rawRoutes = Array.isArray(o["routes"]) ? o["routes"] : [];
  const routes: RouteRender[] = [];

  for (const entry of rawRoutes) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const route = typeof e["route"] === "string" ? e["route"] : null;
    if (!route) continue;

    const blank = e["blank"] === true;
    const overlay = typeof e["overlay"] === "string" && e["overlay"].trim() ? e["overlay"].trim() : undefined;
    const errors = (Array.isArray(e["errors"]) ? e["errors"] : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 0 && !isHmrNoise(x));
    const text = typeof e["text"] === "string" ? e["text"].slice(0, MAX_TEXT_CHARS) : "";
    const emptyState = typeof e["emptyState"] === "string" && e["emptyState"].trim()
      ? e["emptyState"].trim().slice(0, 120)
      : undefined;
    const contentIssue = typeof e["contentIssue"] === "string" && e["contentIssue"].trim()
      ? e["contentIssue"].trim().slice(0, 500)
      : undefined;

    const failedRequests = (Array.isArray(e["failedRequests"]) ? e["failedRequests"] : [])
      .flatMap((x) => {
        if (typeof x !== "object" || x === null) return [];
        const f = x as Record<string, unknown>;
        const url = typeof f["url"] === "string" ? f["url"] : null;
        const status = typeof f["status"] === "number" ? f["status"] : null;
        if (url === null || status === null || COSMETIC_ASSET.test(url)) return [];
        return [{ url, status }];
      });

    const rawLayout = typeof e["layout"] === "object" && e["layout"] !== null
      ? e["layout"] as Record<string, unknown>
      : null;
    const parseViewport = (value: unknown): ViewportLayout | undefined => {
      if (typeof value !== "object" || value === null) return undefined;
      const v = value as Record<string, unknown>;
      const number = (key: string): number | null =>
        typeof v[key] === "number" && Number.isFinite(v[key]) ? v[key] as number : null;
      const width = number("width"), height = number("height"), scrollWidth = number("scrollWidth");
      const horizontalOverflow = number("horizontalOverflow"), mainCount = number("mainCount");
      const navCount = number("navCount"), asideCount = number("asideCount"), headingCount = number("headingCount");
      if ([width, height, scrollWidth, horizontalOverflow, mainCount, navCount, asideCount, headingCount].some((n) => n === null)) return undefined;
      return {
        width: width!, height: height!, scrollWidth: scrollWidth!, horizontalOverflow: horizontalOverflow!,
        mainCount: mainCount!, navCount: navCount!, asideCount: asideCount!, headingCount: headingCount!,
        passwordFormWidth: number("passwordFormWidth"),
        bodyFontFamily: typeof v["bodyFontFamily"] === "string" ? v["bodyFontFamily"].slice(0, 120) : "",
        bodyBackground: typeof v["bodyBackground"] === "string" ? v["bodyBackground"].slice(0, 80) : "",
      };
    };
    const desktop = rawLayout ? parseViewport(rawLayout["desktop"]) : undefined;
    const mobile = rawLayout ? parseViewport(rawLayout["mobile"]) : undefined;
    const layoutIssues: string[] = [];
    if (mobile && mobile.horizontalOverflow > 8) {
      layoutIssues.push(`mobile layout overflows horizontally by ${mobile.horizontalOverflow}px at ${mobile.width}px`);
    }
    if (desktop?.passwordFormWidth !== null && desktop?.passwordFormWidth !== undefined && desktop.passwordFormWidth > 560) {
      layoutIssues.push(`authentication form is too wide on desktop (${desktop.passwordFormWidth}px; expected a constrained card/panel no wider than 560px)`);
    }
    if (mobile?.passwordFormWidth !== null && mobile?.passwordFormWidth !== undefined && mobile.passwordFormWidth > 370) {
      layoutIssues.push(`authentication form has no safe mobile side margin (${mobile.passwordFormWidth}px at ${mobile.width}px)`);
    }
    const layout = desktop || mobile ? {
      ...(desktop ? { desktop } : {}),
      ...(mobile ? { mobile } : {}),
    } : undefined;

    routes.push({
      route,
      ok: !blank && !overlay && !emptyState && !contentIssue && errors.length === 0 && failedRequests.length === 0 && layoutIssues.length === 0,
      blank,
      errors,
      ...(emptyState ? { emptyState } : {}),
      ...(contentIssue ? { contentIssue } : {}),
      ...(overlay ? { overlay } : {}),
      failedRequests,
      text,
      ...(layout ? { layout } : {}),
      ...(layoutIssues.length ? { layoutIssues } : {}),
    });
  }

  const unreachable = (Array.isArray(o["unreachable"]) ? o["unreachable"] : [])
    .filter((x): x is string => typeof x === "string");

  return { routes, unreachable };
}

/** Everything rendered and nothing errored. */
export function allRoutesOk(report: RenderReport): boolean {
  return report.unreachable.length === 0 && report.routes.every((r) => r.ok);
}

/**
 * A second check reports only what MOVED.
 *
 * The browser sweep is nearly free; the expensive part is that everything this
 * tool returns is re-paid in the model's context on every round that follows.
 * A build that checks eight times should not pay eight times to be told the
 * same four pages are still fine.
 *
 * Two rules keep this from becoming a way to hide problems:
 *
 *   A route that is STILL broken is always restated. Silence about a known
 *   failure reads as "fixed" to a model that has forgotten it, and the one
 *   thing this whole module exists to prevent is an agent believing it
 *   verified something it did not.
 *
 *   Text that changed is always shown, even on a page that was and remains
 *   fine. That is how the model finds out whether its last edit reached the
 *   screen — which, for a model whose written code sometimes never applies, is
 *   the single most useful thing a re-check can say.
 */
function formatRenderDiff(now: RenderReport, before: RenderReport): string {
  const prior = new Map(before.routes.map((r) => [r.route, r]));
  const fixed: string[] = [];
  const brokeNow: RouteRender[] = [];
  const stillBroken: RouteRender[] = [];
  const changedText: RouteRender[] = [];
  const appeared: RouteRender[] = [];

  for (const r of now.routes) {
    const was = prior.get(r.route);
    if (!was) {
      appeared.push(r);
      continue;
    }
    if (was.ok && !r.ok) brokeNow.push(r);
    else if (!was.ok && r.ok) fixed.push(r.route);
    else if (!r.ok) stillBroken.push(r);
    else if (r.text !== was.text) changedText.push(r);
  }

  const gone = before.routes.filter((r) => !now.routes.some((n) => n.route === r.route));
  const lines: string[] = [];

  for (const r of brokeNow) {
    lines.push(`  ${r.route} BROKE: ${describeProblem(r)}`);
    if (r.text) lines.push(`      shows: "${r.text}"`);
  }
  for (const r of appeared) {
    lines.push(
      r.ok
        ? `  ${r.route} is new — ${r.text ? `shows "${r.text}"` : "renders, but has NO text on it at all"}`
        : `  ${r.route} is new and BROKEN: ${describeProblem(r)}`,
    );
  }
  for (const route of fixed) lines.push(`  ${route} is fixed — it renders now`);
  // Always restated. See the second rule above.
  for (const r of stillBroken) lines.push(`  ${r.route} is STILL broken: ${describeProblem(r)}`);
  for (const r of changedText) lines.push(`  ${r.route} now shows: "${r.text}"`);
  if (gone.length > 0) lines.push(`  no longer declared: ${gone.map((r) => r.route).join(", ")}`);

  if (now.unreachable.length > 0) {
    lines.push(
      `  could not open: ${now.unreachable.join(", ")} — nothing was verified about these.`,
    );
  }

  if (lines.length === 0) {
    const n = now.routes.length;
    return `No change since the last check — all ${n} page(s) still render, with the same content.`;
  }

  return `Since the last check:\n${lines.join("\n")}`;
}

/** `GET /api/shifts returned 500`, which is actionable, rather than a count. */
function describeRequests(r: RouteRender): string {
  return r.failedRequests
    .map((f) => {
      // Only the path. The sandbox host is noise the model cannot act on and
      // pays for on every later round.
      let path = f.url;
      try { path = new URL(f.url).pathname; } catch { /* not absolute; use as-is */ }
      return `${path} returned ${f.status}`;
    })
    .join("; ");
}

function describeProblem(r: RouteRender): string {
  if (r.emptyState) {
    return `shows the initial empty state "${r.emptyState}" instead of populated sample content`;
  }
  if (r.contentIssue) return r.contentIssue;
  if (r.blank) {
    return r.errors.length > 0
      ? `renders NOTHING (#root is empty) — ${r.errors[0]}`
      : "renders NOTHING (#root is empty, and no error explains why)";
  }
  if (r.overlay) return `Vite error overlay: ${r.overlay}`;
  const parts: string[] = [];
  if (r.errors.length > 0) parts.push(`console error: ${r.errors.join("; ")}`);
  if (r.failedRequests.length > 0) parts.push(`request failed: ${describeRequests(r)}`);
  if (r.layoutIssues?.length) parts.push(...r.layoutIssues);
  return parts.join(" · ");
}

/**
 * What the model is told.
 *
 * Verbose exactly where something is wrong and terse everywhere else, because
 * every line here is re-paid on every later round. A broken route gets its
 * error AND its text, since the two together are usually what identifies the
 * cause. A working route gets its text once — short, but present, because a
 * page that renders the wrong thing is the failure this check exists to catch
 * and an "ok" alone would hide it exactly as the old one-sentence check did.
 */
export function formatRenderForAgent(report: RenderReport, previous?: RenderReport | null): string {
  if (previous) return formatRenderDiff(report, previous);

  const lines: string[] = [];

  if (report.routes.length === 0 && report.unreachable.length === 0) {
    return "No routes could be checked.";
  }

  const broken = report.routes.filter((r) => !r.ok);
  const working = report.routes.filter((r) => r.ok);

  if (broken.length > 0) {
    lines.push(`${broken.length} of ${report.routes.length} page(s) are broken:`);
    for (const r of broken) {
      lines.push(`  ${r.route} — ${describeProblem(r)}`);
      if (r.text) lines.push(`      shows: "${r.text}"`);
    }
  }

  if (report.unreachable.length > 0) {
    lines.push(
      `Could not open: ${report.unreachable.join(", ")} — the page did not load at all. ` +
      `Nothing was verified about these; do not treat them as working.`,
    );
  }

  if (working.length > 0) {
    lines.push(
      broken.length > 0 || report.unreachable.length > 0
        ? `Rendering normally:`
        : `All ${working.length} page(s) render:`,
    );
    for (const r of working) {
      lines.push(r.text ? `  ${r.route} — "${r.text}"` : `  ${r.route} — renders, but has NO text on it at all`);
    }
  }

  // Report browser-measured facts without pretending they are a subjective aesthetic score.
  for (const r of report.routes) {
    const d = r.layout?.desktop;
    const m = r.layout?.mobile;
    if (!d && !m) continue;
    const summary = [
      d ? `desktop ${d.width}px: overflow=${d.horizontalOverflow}px, main=${d.mainCount}, nav=${d.navCount}, aside=${d.asideCount}, h1=${d.headingCount}${d.passwordFormWidth === null ? "" : `, auth-form=${d.passwordFormWidth}px`}` : "",
      m ? `mobile ${m.width}px: overflow=${m.horizontalOverflow}px${m.passwordFormWidth === null ? "" : `, auth-form=${m.passwordFormWidth}px`}` : "",
    ].filter(Boolean).join("; ");
    lines.push(`  ${r.route} layout audit: ${summary}`);
    for (const issue of r.layoutIssues ?? []) lines.push(`    UI FIX REQUIRED: ${issue}`);
  }

  // The point of carrying the text back. A page can render, type-check and
  // pass its tests while showing none of what was asked for — which is exactly
  // what ROTA did — so the model is told to read what it just saw rather than
  // treat a clean error count as success.
  if (broken.length === 0 && report.unreachable.length === 0) {
    lines.push(
      `No errors anywhere. Now read the text above: does each page actually show what ` +
      `the user asked for? A collection product may have zero live records, but its ` +
      `workspace still needs real sections, useful summaries and an intentional empty-data ` +
      `state — a page that renders only a heading and one button is not complete.`,
    );
  }

  return lines.join("\n");
}
