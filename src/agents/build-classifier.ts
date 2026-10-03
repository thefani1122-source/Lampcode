export interface BuildClassification {
  buildType: "frontend" | "fullstack";
  framework: "react" | "nextjs" | "tanstack";
  database: "supabase" | "mongodb" | "none";
  needsAuth: boolean;
  reason: string;
}

// Keyword-based classifier — no LLM call, instant synchronous result.
export function classifyBuild(prompt: string): Promise<BuildClassification> {
  // Framework is pinned to "react" on purpose. The Next.js and TanStack Start
  // E2B templates were never built — selectTemplate() still carries the TODOs
  // for them (e2b-service.ts:46,49) and silently falls back to the Vite
  // template, so returning either value here produced a sandbox that could not
  // boot: `npm run dev` with no Next.js installed, a readiness poll against
  // :3000 when Vite serves :5173, and an expected entry point (app/page.tsx)
  // the generator was told to write but the template can't serve.
  // NEXTJS_TEMPLATE_ID/TANSTACK_TEMPLATE_ID being set is NOT a safe signal to
  // re-enable on — they are populated in production but point at no real
  // template. Restore the detection only once a template actually builds.
  const framework: BuildClassification["framework"] = "react";
  // The keywords still count toward the fullstack decision below — asking for
  // "a Next.js dashboard" is a backend-shaped request even though we serve it
  // from the React template.
  const mentionsServerFramework = /next\.?js|tanstack/i.test(prompt);

  // ── Does this app actually need a server and a database? ─────────────────
  // This used to be ONE alternation mixing three unrelated kinds of signal,
  // and the 2026-10-03 eval measured what that cost: half the smoke set asked
  // for a browser-only app and got a Hono backend plus a Supabase schema. With
  // the preview Supabase project paused, those builds cannot persist anything —
  // the app ships, the writes fail. Split into named signals instead.

  // Signals that genuinely require a server: another machine has to hold the
  // data, or money/files/identity are involved.
  const SERVER_DATA_RE =
    /\b(save.to.database|real.database|dashboard.with.real.data|supabase|mongodb|postgresql|postgres|sqlite|mysql|graphql|backend|hono|fastapi|api.routes?|rest.api|multiple.users?|multi[- ]user|real[- ]time|payments?|stripe|checkout|file.uploads?|crud|cloud.sync|server[- ]side)\b/i;

  // Identity. Real auth needs a server; the WORD does not — a "three-step
  // signup form" that validates fields and shows a summary is pure UI, and the
  // eval caught it drawing a database and auth scaffolding it never used.
  const AUTH_RE =
    /\b(login|signin|sign[- ]in|sign[- ]up|signup|auth(?:entication|orization)?|user[- ]account|user[- ]profile|register(?:ation)?|logout|sign[- ]out|oauth|jwt|session|password|credential|admin[- ]panel)\b/i;

  // Markers that the user means the browser, not a server. "Tasks persist
  // across reloads" is localStorage in almost every real request, which is why
  // a bare `persist` is no longer a server signal at all — "save to database"
  // and "real database" already catch the case where they mean otherwise.
  const CLIENT_ONLY_RE =
    /\b(localstorage|local.storage|session.storage|indexeddb|browser.storage|no.backend|without.a.backend|frontend[- ]only|client[- ]side.only|offline|mock.data|mocked|fake.data|dummy.data)\b/i;

  // An auth word describing a thing being BUILT as UI, rather than a system to
  // stand up. "a login page" is a page; "users log in with Google" is a system.
  const AUTH_AS_UI_RE =
    /\b(login|signin|sign[- ]in|sign[- ]up|signup|register(?:ation)?|password|auth)\b[- ]?\w*\s+(form|page|screen|ui|modal|dialog|layout|mockup|design|flow)\b/i;

  // "no backend" contains the word "backend", so a bare match read an
  // instruction NOT to build one as an instruction to build one — caught by
  // scripts/classifier.test.ts. Strip explicit negations before looking for
  // server signals. A named database still wins: "store it in Supabase" is not
  // negated by anything, so "cache in localStorage" cannot cancel it.
  const deNegated = prompt.replace(
    /\b(?:no|without(?:\s+an?)?|not?\s+need(?:ing)?(?:\s+an?)?)\s+(?:backend|server|database|api|db)\b/gi,
    " ",
  );
  const hasServerData = SERVER_DATA_RE.test(deNegated);
  const clientOnly = CLIENT_ONLY_RE.test(prompt);
  // Auth counts toward a server UNLESS the prompt is describing auth as a piece
  // of interface, or has already said it wants browser-side everything.
  const hasRealAuth = AUTH_RE.test(deNegated) && !AUTH_AS_UI_RE.test(prompt) && !clientOnly;

  // 3D / animation keywords are deliberately NOT here any more. They used to
  // force fullstack with the stated reason of routing the build to E2B, where
  // Three.js and Spline are pre-installed — but `wantsE2BPreview` in build.ts
  // is now hardcoded true, so every build goes to E2B regardless. All those
  // keywords did by the end was give a Three.js landing page a database.
  //
  // A hard server signal still wins over a client-only marker: "store it in
  // Supabase and cache in localStorage" needs the server.
  const isFullstack = mentionsServerFramework || hasServerData || hasRealAuth;

  // Database detection
  const database: BuildClassification["database"] = isFullstack
    ? /\bmongo(?:db)?\b/i.test(prompt) ? "mongodb" : "supabase"
    : "none";

  // Auth scaffolding follows the same reading — a signup form must not get an
  // auth system it was never asked for.
  const needsAuth = hasRealAuth;

  const buildType = isFullstack ? "fullstack" : "frontend";
  const reason =
    mentionsServerFramework ? "server framework named in the prompt"
    : hasServerData         ? "needs a server: data/payments/files/multi-user signal"
    : hasRealAuth           ? "needs a server: real authentication, not an auth UI"
    : clientOnly            ? "browser-side only — explicit client-storage or no-backend marker"
    : "no server signal — frontend";

  return Promise.resolve({ buildType, framework, database, needsAuth, reason });
}
