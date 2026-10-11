/**
 * What in this app LOOKS built but does nothing.
 *
 * `dead-code.ts` answers one question exactly: is this file reachable from
 * anything else? That question caught the ROTA build, where four views the user
 * asked for were written and never imported. But it is the wrong question for
 * the complaint that actually reaches a user, which is never "a file is
 * unreachable" — it is **the button does nothing and the page never loads**.
 *
 * Those are different failures and they survive every gate we have. A `<button>`
 * with no `onClick` renders perfectly, type-checks, and passes a test nobody
 * wrote for it. A `<Link to="/rules">` pointing at a route that was never
 * declared renders as a real link; clicking it does nothing visible. A
 * `fetch("/api/shifts")` against an endpoint the backend never defined fails at
 * runtime, in the user's browser, after the build was reported complete. In all
 * three the app is structurally whole and behaviourally hollow.
 *
 * None of this needs a model. Each rule below is a question a program answers
 * exactly, which is the test for belonging in this module and the reason it
 * costs nothing to ask on every build.
 *
 * **Why this is a separate module from `dead-code.ts`.** That file's contract is
 * written around the fact that the response to its findings is DELETING code, so
 * every rule there under-reports and a false positive costs a working app. The
 * response to a finding here is WRITING code — wiring a handler, declaring a
 * route, adding the missing endpoint. Different action, different blast radius,
 * different caller. Folding these rules into that file would quietly break the
 * contract its comments spend forty lines establishing.
 *
 * The under-reporting discipline still applies, for a different reason: a false
 * positive here spends a repair dispatch rewriting code that was already
 * correct, and a repair that changes working code is a regression, not a fix.
 * So every rule below skips the case it cannot read confidently rather than
 * guessing. A missed hollow button costs one bad user impression. A wrongly
 * reported live one costs a working feature.
 */

import { stripComments } from "./dead-code.js";

export type WiringKind =
  | "dead-handler"
  | "button-no-handler"
  | "form-no-submit"
  | "dead-link"
  | "missing-endpoint"
  | "orphan-endpoint"
  | "placeholder-text";

export type WiringFinding = {
  kind: WiringKind;
  path: string;
  /** The element, route, endpoint or string the finding is about. */
  symbol: string;
  /** One line, written for the model that has to fix it. */
  detail: string;
};

/** Cap on what is PRINTED, not on what is found — the same split `dead-code.ts`
 *  had to make after a truncated scan silently truncated the recorded tally. */
const MAX_REPORTED = 30;

const JSX_EXT_RE = /\.(tsx|jsx)$/;
const CODE_EXT_RE = /\.(tsx?|jsx?|mts|mjs)$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;
const PY_EXT_RE = /\.py$/;

function normalise(path: string): string {
  return path.replace(/^\.?\//, "");
}

/**
 * The source of one JSX opening tag, from `<name` to its own closing `>`.
 *
 * Scans rather than regexes because an attribute value can contain the
 * terminator: `onClick={() => setN(n > 1)}` has a `>` inside a braced
 * expression, and `title=">"` has one inside a string. Tracking brace depth and
 * quote state is the whole job — a regex for `<button[^>]*>` cuts both of those
 * tags in half and then every attribute test below reads a fragment.
 */
export function extractTags(code: string, name: string): Array<{ source: string; index: number }> {
  const out: Array<{ source: string; index: number }> = [];
  const re = new RegExp(`<${name}(?=[\\s/>])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + name.length + 1;
    let depth = 0;
    let quote = "";
    for (; i < code.length; i++) {
      const c = code[i] as string;
      if (quote !== "") {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") { depth++; continue; }
      if (c === "}") { depth--; continue; }
      if (c === ">" && depth <= 0) break;
    }
    out.push({ source: code.slice(m.index, Math.min(i + 1, code.length)), index: m.index });
  }
  return out;
}

/** How far back to look for an `asChild` parent. Generous on purpose: missing a
 *  finding is cheaper than rewriting a working control. */
const AS_CHILD_LOOKBACK = 200;

/**
 * Is this element's handler injected by an `asChild` parent?
 *
 * Measured against the real frontend, 2026-10-11. Over 93 hand-written files
 * the rules produced four element findings, and two were wrong for one shared
 * reason: a `<button>` sitting inside `<DropdownMenuTrigger asChild>`. Radix —
 * and therefore shadcn, and therefore most generated apps, since the template
 * ships it — clones its single child and injects `onClick` into it. The child
 * genuinely has no handler in the source and genuinely works at runtime, so the
 * rule as first written would have sent a repair dispatch to "fix" two
 * functioning menus.
 *
 * A closing tag between the `asChild` and this element means that trigger was
 * already closed and this element is a sibling, not its child — so the skip
 * does not leak onto the next control in the file. That mattered: the same probe
 * found a genuinely dead "Switch project" button, and a file-wide `asChild` test
 * would have hidden it.
 */
function handlerFromAsChildParent(code: string, tagIndex: number): boolean {
  const window = code.slice(Math.max(0, tagIndex - AS_CHILD_LOOKBACK), tagIndex);
  const at = window.lastIndexOf("asChild");
  if (at < 0) return false;
  return !window.slice(at).includes("</");
}

/**
 * Every `onSomething={…}` in the file, with the expression inside the braces.
 *
 * Depth-tracked for the same reason as `extractTags`: the common shape of a
 * real handler is `onClick={() => { setOpen(!open); }}`, whose expression
 * contains two nested braces. A non-greedy `\{([^}]*)\}` stops at the first one
 * and reports the handler as `() => { setOpen(!open);` — which parses as neither
 * dead nor live, so the rule would have to guess.
 */
export function handlerExpressions(code: string): Array<{ name: string; expr: string }> {
  const out: Array<{ name: string; expr: string }> = [];
  const re = /\bon([A-Z]\w*)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const start = re.lastIndex;
    let depth = 1;
    let quote = "";
    let i = start;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i] as string;
      if (quote !== "") {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.push({ name: `on${m[1] ?? ""}`, expr: code.slice(start, Math.max(start, i - 1)).trim() });
    re.lastIndex = i;
  }
  return out;
}

/**
 * Does this handler expression provably do nothing?
 *
 * Only an INLINE literal is judged. `onClick={handleClick}` is a reference, and
 * deciding whether the thing it names is a stub means resolving the identifier —
 * which is the analysis this module is explicitly not doing. A named handler
 * that happens to be empty is a missed finding, and that is the safe direction.
 *
 * A body of nothing but `console.*` calls counts as dead. That is the shape a
 * model writes when it is standing a UI up before deciding what the button
 * means, and it is indistinguishable to a user from an empty body. `alert(…)` is
 * deliberately NOT in that set — it is ugly, but it does something the user can
 * see, so calling it dead would be wrong.
 */
export function isDeadHandler(expr: string): boolean {
  const e = stripComments(expr).trim();
  if (e === "" || e === "undefined" || e === "null") return true;

  // An arrow or function whose block body is empty or logs only.
  const arrow = /^(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*([\s\S]*)$/.exec(e);
  const fn = /^(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*([\s\S]*)$/.exec(e);
  const after = arrow?.[1] ?? fn?.[1];
  if (after === undefined) return false;

  const body = after.trim();
  if (body === "undefined" || body === "null" || body === "void 0") return true;
  if (!body.startsWith("{")) return false;
  if (!body.endsWith("}")) return false;

  const inner = body.slice(1, -1).trim();
  if (inner === "") return true;
  if (/^(?:console\.\w+\s*\([^;]*\)\s*;?\s*)+$/.test(inner)) return true;
  return false;
}

/**
 * A tag's attribute names, so "does this button have an onClick" is a lookup
 * rather than a substring test — `data-onclick` must not count.
 *
 * Values are stripped BEFORE names are collected, and both halves of that
 * matter. Requiring a following `=` misses bare boolean attributes, so
 * `<button disabled>` read as having no attributes at all and was reported as
 * unwired. Not stripping values lets a name inside a string count as an
 * attribute, so `<button title="onClick demo">` would look wired and be skipped.
 * One is a false positive and the other a missed finding; the scanner avoids
 * both by walking the tag with quote and brace state, exactly as `extractTags`
 * does.
 */
export function tagAttributes(tag: string): string[] {
  let bare = "";
  let i = 0;
  let quote = "";
  let depth = 0;
  while (i < tag.length) {
    const c = tag[i] as string;
    if (quote !== "") {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    bare += c;
    i++;
  }
  const out: string[] = [];
  const re = /\s([A-Za-z_][\w:-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) if (m[1]) out.push(m[1]);
  return out;
}

function hasSpread(tag: string): boolean {
  return /\{\s*\.\.\./.test(tag);
}

/**
 * Collapse a route or request path so a declaration and a call can be compared.
 *
 * `/api/todos/:id`, `/api/todos/{id}` and `` `/api/todos/${id}` `` are the same
 * endpoint written three ways — Express, FastAPI and a template literal. Any
 * segment that is a parameter in any of those notations becomes `*`.
 */
export function normalizeRoute(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  const trimmed = noQuery.replace(/\/+$/, "") || "/";
  return trimmed
    .split("/")
    .map((seg) =>
      seg.startsWith(":") || /^\{.*\}$/.test(seg) || seg.includes("${") || seg.includes("<")
        ? "*"
        : seg,
    )
    .join("/");
}

/** Route paths the app declares, from a router config or a backend. */
export function declaredRoutes(code: string): string[] {
  const out = new Set<string>();
  // <Route path="/x">, { path: "/x" }, createRoute({ path: '/x' })
  const re = /\bpath\s*[=:]\s*\{?\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Where the UI tries to navigate. */
export function linkTargets(code: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:to|href)\s*=\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const t = m[1] ?? "";
    if (t === "" || t.startsWith("#") || t.startsWith("mailto:") || t.startsWith("tel:")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // external
    if (!t.startsWith("/")) continue; // relative — resolving it needs the route tree
    out.add(t);
  }
  return [...out];
}

/** Endpoints the backend defines. Express/Hono-shaped and FastAPI-shaped. */
export function backendEndpoints(code: string): string[] {
  const out = new Set<string>();
  const js = /\b(?:app|router|api|server)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = js.exec(code)) !== null) if (m[1]) out.add(m[1]);
  const py = /@\s*(?:app|router|api)\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = py.exec(code)) !== null) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Endpoints the frontend calls. */
export function requestedEndpoints(code: string): string[] {
  const out = new Set<string>();
  // fetch("/api/x"), fetch(`/api/x/${id}`), axios.get("/api/x"), api.post("/api/x")
  const re = /\b(?:fetch|axios(?:\.\w+)?|api(?:\.\w+)?|request)\s*\(\s*['"`]([^'"`]*\/api\/[^'"`]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const raw = m[1] ?? "";
    const idx = raw.indexOf("/api/");
    if (idx < 0) continue;
    out.add(raw.slice(idx));
  }
  return [...out];
}

/**
 * Strings a user should never be shown in a finished app.
 *
 * This rule is the one here that depends on WHOSE code is being read, and the
 * probe against the real frontend made that concrete: it reported three
 * "coming soon" strings, and all three were deliberate product copy a person
 * chose to ship. In generated output the same string means the opposite — the
 * user asked for a feature and the model wrote a label instead of building it.
 * Correct in the only place this module runs, and it would be wrong as a
 * general-purpose lint.
 */
const PLACEHOLDER_RE =
  /\b(?:coming soon|lorem ipsum|not implemented|to ?be implemented|placeholder text|your content here|TODO:)/i;

function isBackendFile(path: string): boolean {
  return (
    path.startsWith("src/server/") ||
    path.startsWith("server/") ||
    path.startsWith("api/") ||
    /(^|\/)(main|app|server)\.py$/.test(path)
  );
}

/**
 * Everything in this app that looks built and does nothing, as far as text can
 * tell.
 *
 * Seven rules. Each is skipped rather than guessed whenever the file shape makes
 * it unreadable — the skips are documented inline, because each one is a
 * deliberate missed finding and the next person to read this will otherwise try
 * to "fix" it.
 */
export function findWiringGaps(files: Record<string, string>): WiringFinding[] {
  const code: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (!CODE_EXT_RE.test(path) && !PY_EXT_RE.test(path)) continue;
    // Guard rather than trust the type: this runs on every build, and throwing
    // here would turn an advisory report into a failed build.
    if (typeof content !== "string") continue;
    if (TEST_FILE_RE.test(path)) continue;
    code[path] = stripComments(content);
  }

  const findings: WiringFinding[] = [];

  for (const [path, src] of Object.entries(code)) {
    const isJsx = JSX_EXT_RE.test(path);

    // ── 1. A handler that provably does nothing ───────────────────────────────
    if (isJsx) {
      const seen = new Set<string>();
      for (const { name, expr } of handlerExpressions(src)) {
        if (!isDeadHandler(expr)) continue;
        const key = `${name}:${expr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          kind: "dead-handler",
          path,
          symbol: name,
          detail:
            `${name} is wired to an empty body, so the element renders and clicking it does ` +
            `nothing — implement it or remove the element`,
        });
      }
    }

    // ── 2. A button with nothing attached ─────────────────────────────────────
    // Skipped entirely in a file containing a <form>: a bare <button> inside a
    // form submits it by default in HTML, so reporting one there would be wrong
    // and the fix would add a handler that double-submits. Locating the form
    // boundary properly needs a parser, so the whole file is left alone.
    if (isJsx && !/<form[\s/>]/.test(src)) {
      for (const { source: tag, index } of extractTags(src, "button")) {
        if (hasSpread(tag)) continue; // props forwarded from a wrapper component
        if (handlerFromAsChildParent(src, index)) continue;
        const attrs = tagAttributes(tag);
        if (attrs.some((a) => /^on[A-Z]/.test(a))) continue;
        if (attrs.includes("disabled") || attrs.includes("form")) continue;
        if (/type\s*=\s*['"]submit['"]/.test(tag)) continue;
        if (attrs.includes("type") && /type\s*=\s*\{/.test(tag)) continue; // dynamic
        findings.push({
          kind: "button-no-handler",
          path,
          symbol: tag.replace(/\s+/g, " ").slice(0, 60),
          detail:
            "a <button> with no onClick and no type=\"submit\" — it renders but cannot do " +
            "anything; attach the action it is labelled with",
        });
      }
    }

    // ── 3. A form that submits nowhere ────────────────────────────────────────
    if (isJsx) {
      for (const { source: tag, index } of extractTags(src, "form")) {
        if (hasSpread(tag)) continue;
        if (handlerFromAsChildParent(src, index)) continue;
        const attrs = tagAttributes(tag);
        if (attrs.includes("onSubmit") || attrs.includes("action")) continue;
        findings.push({
          kind: "form-no-submit",
          path,
          symbol: tag.replace(/\s+/g, " ").slice(0, 60),
          detail:
            "a <form> with no onSubmit and no action — typing in it and pressing enter reloads " +
            "the page and loses the input; add onSubmit with preventDefault",
        });
      }
    }

    // ── 7. Placeholder copy that shipped ──────────────────────────────────────
    if (isJsx) {
      const m = PLACEHOLDER_RE.exec(src);
      if (m) {
        findings.push({
          kind: "placeholder-text",
          path,
          symbol: m[0],
          detail:
            `the string "${m[0]}" is rendered to the user — this is stub copy left in place of ` +
            `the feature; build the feature or remove the section`,
        });
      }
    }
  }

  // ── 4. A link to a route that was never declared ────────────────────────────
  // Only when the project declares routes at all. A single-page app uses anchors
  // for in-page jumps and has no route table, and comparing against an empty set
  // would report every one of them.
  const allRoutes = new Set<string>();
  for (const src of Object.values(code)) {
    for (const r of declaredRoutes(src)) allRoutes.add(normalizeRoute(r));
  }
  if (allRoutes.size > 0) {
    for (const [path, src] of Object.entries(code)) {
      const seen = new Set<string>();
      for (const target of linkTargets(src)) {
        const norm = normalizeRoute(target);
        if (allRoutes.has(norm)) continue;
        // A declared "*" or "/" catch-all makes any path reachable.
        if (allRoutes.has("*") || allRoutes.has("/*")) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        findings.push({
          kind: "dead-link",
          path,
          symbol: target,
          detail:
            `links to "${target}" but no route declares that path, so clicking it changes the ` +
            `URL and renders nothing — declare the route or point the link at one that exists`,
        });
      }
    }
  }

  // ── 5 & 6. Frontend and backend disagreeing about the API ───────────────────
  // Only when the app actually has a backend. Without one, every fetch goes to a
  // service this analysis cannot see.
  const backendPaths = Object.keys(code).filter(isBackendFile);
  if (backendPaths.length > 0) {
    const defined = new Set<string>();
    for (const p of backendPaths) {
      for (const e of backendEndpoints(code[p] as string)) defined.add(normalizeRoute(e));
    }

    const requested = new Map<string, string>(); // normalised → first raw form
    const requestedIn = new Map<string, string>(); // normalised → file
    for (const [path, src] of Object.entries(code)) {
      if (isBackendFile(path)) continue;
      for (const e of requestedEndpoints(src)) {
        const norm = normalizeRoute(e);
        if (!requested.has(norm)) {
          requested.set(norm, e);
          requestedIn.set(norm, path);
        }
      }
    }

    // A backend that mounts its routes under a prefix declares "/todos" while
    // the frontend calls "/api/todos". Both spellings are accepted so a correct
    // app is not reported.
    const definedWithPrefix = new Set<string>();
    for (const d of defined) {
      definedWithPrefix.add(d);
      if (!d.startsWith("/api")) definedWithPrefix.add(normalizeRoute(`/api${d}`));
    }

    for (const [norm, raw] of requested) {
      if (definedWithPrefix.has(norm)) continue;
      findings.push({
        kind: "missing-endpoint",
        path: requestedIn.get(norm) ?? "",
        symbol: raw,
        detail:
          `calls "${raw}" but the backend defines no such route, so this request 404s at ` +
          `runtime and the feature silently fails — add the endpoint or fix the path`,
      });
    }

    if (requested.size > 0) {
      const requestedNorms = new Set(requested.keys());
      for (const p of backendPaths) {
        for (const e of backendEndpoints(code[p] as string)) {
          const norm = normalizeRoute(e);
          if (requestedNorms.has(norm)) continue;
          if (requestedNorms.has(normalizeRoute(`/api${e}`))) continue;
          if (norm.startsWith("/api") && requestedNorms.has(norm.slice(4) || "/")) continue;
          findings.push({
            kind: "orphan-endpoint",
            path: p,
            symbol: e,
            detail:
              `defines "${e}" but no frontend file calls it — either the UI for it was never ` +
              `wired up, or the endpoint is left over from an earlier edit`,
          });
        }
      }
    }
  }

  return findings;
}

/** Counts for `build_outcome`, so "do we ship hollow apps?" becomes a number
 *  instead of an impression. */
export function tallyWiringGaps(findings: WiringFinding[]): Record<WiringKind, number> & {
  total: number;
} {
  const t = {
    "dead-handler": 0,
    "button-no-handler": 0,
    "form-no-submit": 0,
    "dead-link": 0,
    "missing-endpoint": 0,
    "orphan-endpoint": 0,
    "placeholder-text": 0,
    total: 0,
  };
  for (const f of findings) {
    t[f.kind] += 1;
    t.total += 1;
  }
  return t;
}

/**
 * The repair prompt's input, and the tool's reply.
 *
 * Phrased as instructions rather than a list because this is the one check in
 * the verify family whose findings are meant to be ACTED on, not confirmed: the
 * analysis is textual, so the model still has to read each file, but a button
 * with no handler has exactly one correct response and the report should say so.
 */
export function formatWiringGaps(findings: WiringFinding[]): string {
  if (findings.length === 0) {
    return "Every button, form, link and API call in this project is wired to something. Nothing hollow found.";
  }
  const shown = findings.slice(0, MAX_REPORTED);
  return [
    `${findings.length} thing(s) in this project render but do nothing:`,
    "",
    ...shown.map((f) => `- ${f.path} — ${f.symbol}: ${f.detail}`),
    ...(findings.length > shown.length
      ? ["", `… and ${findings.length - shown.length} more, not listed.`]
      : []),
    "",
    "These are not style notes. Each one is a thing the user can see and click that will not " +
    "respond. Read the file before changing it — this analysis is textual, so confirm the " +
    "element is really unwired and not receiving its handler from a parent — then implement " +
    "the behaviour the element is labelled with. Do not satisfy a finding by deleting the " +
    "element the user asked for.",
  ].join("\n");
}
