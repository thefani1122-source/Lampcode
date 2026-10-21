import { logger } from "../server/logger.js";
import type { AgentDispatcher } from "./dispatcher.js";

export interface BuildClassification {
  buildType: "frontend" | "fullstack";
  framework: "react" | "nextjs" | "tanstack";
  database: "supabase" | "mongodb" | "none";
  needsAuth: boolean;
  reason: string;
  /** Which layer decided. Recorded because this decision silently governs
   *  everything downstream — the database gate, the prompt the model gets, and
   *  whether a backend is written at all — and when it is wrong nothing else in
   *  the build can recover. "explicit-*" is a word the user actually typed;
   *  "model" is the judgement pass; "lean-*" is the fallback. */
  source: "explicit-client" | "explicit-server" | "model" | "lean-server" | "lean-client";
}

/**
 * Does this request need a server and a database?
 *
 * MEASURED 2026-10-19 — THE REASON THIS FILE WAS REWRITTEN. A real build was
 * asked for:
 *
 *   "Build a team expense tracker. A person signs in … sees only their own
 *    claims … a separate approvals page … nobody may approve their own claim.
 *    Claims persist in the database so they survive a reload."
 *
 * It was classified **frontend**. No backend file was written, no database gate
 * fired, the prompt never carried database instructions, and the app shipped
 * four hardcoded users with localStorage — while its closing message said
 * "complete and fully functional". Probing the old classifier over nine
 * backend-shaped prompts, EIGHT came back frontend:
 *
 *   "a person signs in"                  → frontend  (only the literal
 *   "a user logs in"                     → frontend   "sign in" matched; no
 *   "each customer has their own account"→ frontend   conjugation did)
 *   "a team can see each other's tasks"  → frontend
 *   "notes are stored in the database"   → frontend  (bare "database" was not
 *   "Save the entries to a database"     → frontend   a server signal at all)
 *
 * A word list cannot carry this decision. English has too many ways to say
 * "people log in and their data is saved somewhere", and the failure is silent:
 * a wrong "frontend" produces an app that looks finished and loses the user's
 * data, while a wrong "fullstack" produces an unused backend file. The costs
 * are nowhere near equal, so the layers below are ordered by certainty and the
 * ambiguous middle is given to a model rather than guessed at.
 *
 *   1. The user said browser-only  → frontend. Absolute; nothing overrides it.
 *   2. The user named a server     → fullstack. A database, a framework,
 *      payments, uploads, several people, or auth as a system.
 *   3. Neither                     → ask a model ONE narrow question.
 *   4. No model available          → lean, and say that is what happened.
 *
 * The question in step 3 is deliberately narrow: does the data have to be
 * SHARED between people, or survive on another device? Not "would a backend be
 * nicer". A single-person tracker with no mention of accounts or devices is
 * genuinely a browser app, and answering otherwise would give every notes app
 * a Postgres schema it never uses.
 */

// ── Layer 1: the user asked for the browser ──────────────────────────────────
// Explicit and absolute. "A todo app that persists across reloads in
// localStorage" is not a database request however many other words surround it.
const CLIENT_ONLY_RE =
  /\b(localstorage|local[ -]storage|sessionstorage|session[ -]storage|indexeddb|browser[ -]storage|in[- ]memory|no[ -]backend|no[ -]server|no[ -]database|without[ -](?:a[ -])?(?:backend|server|database)|frontend[- ]only|front[- ]end[- ]only|client[- ]side[- ]only|static[ -]site|offline)\b/i;

/**
 * The user has already said the data is not real.
 *
 * MEASURED 2026-10-21: a checkout task says "payment details (NO REAL
 * PROCESSING)" and was classified fullstack because of the word payment; a
 * table task says "200 MOCK employees" and was classified fullstack because of
 * the word employees. Someone who writes "no real processing" has answered the
 * server question themselves, and the words being disclaimed are exactly the
 * ones the server layer would otherwise match — so this is checked first.
 */
const NOT_REAL_RE =
  /\b(?:no[ -]real[ -](?:processing|payments?|backend|server|database|auth\w*|data|accounts?)|(?:mock|mocked|fake|dummy|sample|seeded?|placeholder|hard[- ]?coded|example)[ -](?:data|content|employees?|users?|customers?|records?|items?|products?|entries|rows|lists?|authentication|auth|payments?|processing|api))\b/i;

// ── Layer 2: the user named a server ─────────────────────────────────────────

/**
 * A database, a backend framework, or an operation that cannot be faked.
 *
 * The money words are phrases, not nouns, for the reason the multi-person list
 * is: measured 2026-10-21, a settings page with a "Billing" TAB and a checkout
 * MOCK-UP were both classified fullstack by the bare words `billing` and
 * `payments`. Taking money needs a verb — accept, process, charge.
 */
const SERVER_THING_RE =
  /\b(database|databases|db|supabase|mongodb|mongo|postgresql|postgres|sqlite|mysql|planetscale|neon|firebase|firestore|dynamodb|redis|graphql|backend|server[- ]side|hono|express|fastapi|django|rails|api[ -]routes?|rest[ -]api|endpoints?|webhooks?|stripe|paddle|lemon[ -]squeezy|accept(?:s|ing)?[ -]payments?|process(?:es|ing)?[ -]payments?|take[ -]payments?|charge[ -](?:cards?|customers?)|real[ -]payments?|(?:subscription|recurring)[ -]billing|file[ -]uploads?|image[ -]uploads?|send(?:s|ing)?[ -](?:an?[ -])?emails?|emails?[ -](?:notification|confirmation|receipt)|cron|scheduled[ -]jobs?|next\.?js|tanstack[ -]start|nuxt|remix|sveltekit)\b/i;

/**
 * Identity as a SYSTEM, in the forms people actually write.
 *
 * The old list held `login|signin|sign[- ]in|signup` and nothing else, so
 * "signs in", "logs in", "logged in", "signing up" and "account" all missed.
 * Conjugation is the single largest source of the measured failure above.
 */
const AUTH_SYSTEM_RE =
  /\b(?:log(?:s|ged|ging)?[ -]?(?:in|out)|sign(?:s|ed|ing)?[ -]?(?:in|up|out)|signin|signup|login|logout|authenticat\w*|authoriz\w*|oauth|sso|jwt|password|credentials?|user[ -]accounts?|create[ -](?:an?[ -])?account|their[ -](?:own[ -])?accounts?|my[ -]account|account[ -]creation|registration|registers?|my[ -]profile|user[ -]profiles?|admin[ -](?:panel|dashboard|area)|user[ -]roles?|role[ -]based|permissions?[ -](?:per|for[ -](?:each|users?)))\b/i;
// `accounts?` on its own used to be here. A settings page with a Danger Zone
// that asks you to type "the account name" is not an identity system, and a
// Billing tab is not Stripe — measured 2026-10-21, both were classified
// fullstack by those two words alone.

/**
 * More than one person, or one person's data kept apart from another's.
 *
 * MEASURED 2026-10-21: the first version of this list held bare nouns —
 * `team|members?|employees?|customers?` — and classified a PRICING PAGE as
 * fullstack because its three tiers are named "Free, Pro, Team", and a table of
 * "200 mock employees" as fullstack because of the word employees. Those are
 * the app's CONTENT, not its architecture. A noun on its own says nothing; the
 * construction around it is what carries the meaning — "each employee", "their
 * own", "team members can", "shared between teams". So every entry here is a
 * phrase rather than a noun, which is the difference between reading a request
 * and pattern-matching its vocabulary.
 */
const MULTI_PERSON_RE =
  /\b(?:multiple[ -]users?|multi[- ]user|multi[- ]tenant|other[ -](?:users?|people)|each[ -](?:user|person|customer|member|employee|student|client|team)|their[ -]own|his[ -]or[ -]her[ -]own|per[- ]user|per[- ]account|only[ -](?:they|them|their|the[ -]owner)|team[ -]members?|my[ -]team|everyone[ -]on[ -]the[ -]team|(?:between|across)[ -]teams?|teammates?|colleagues?|co[- ]workers?|shared[ -](?:with|between)|invite[sd]?[ -](?:a|an|other|new|people|users?|members?)|invitation|assign(?:s|ed|ment)?[ -]to[ -](?:a|an|another|someone|users?|people|members?)|approv\w*[ -]by[ -](?:a|an|another|someone|manager|admin)|real[- ]?time[ -](?:collaborat\w*|updates?|sync)|collaborat\w*|chat[ -](?:between|with[ -](?:other|another))|comment[s]?[ -]on[ -](?:each|another|other|their))\b/i;

/** Data that must outlive one browser on one machine. */
const CROSS_DEVICE_RE =
  /\b(?:another[ -]device|other[ -]devices?|any[ -]device|across[ -]devices|different[ -](?:device|browser|computer|phone)|cloud[ -]sync|sync(?:ed|s|ing)?[ -](?:across|between)|back[ -]?up(?:s|ed)?[ -]to|shared[ -]database|central\w*[ -](?:database|store|server))\b/i;

/**
 * An auth word describing a piece of INTERFACE rather than a system.
 * "a login page" is a page; "users log in with Google" is a system. Kept from
 * the original — the eval caught a three-step signup form being given a
 * database and auth scaffolding it never used.
 */
const AUTH_AS_UI_RE =
  /\b(?:login|signin|sign[- ]in|sign[- ]up|signup|register(?:ation)?|password|auth)\b[- ]?\w*\s+(?:form|page|screen|ui|modal|dialog|layout|mockup|mock[- ]up|design|flow|wireframe)\b/i;

/**
 * Strip explicit negations before looking for server words.
 * "no backend" contains "backend", so a bare match read an instruction NOT to
 * build one as an instruction to build one.
 */
function deNegate(prompt: string): string {
  return prompt.replace(
    /\b(?:no|without(?:\s+an?)?|not?\s+need(?:ing)?(?:\s+an?)?|don'?t\s+(?:need|want|use))\s+(?:a\s+)?(?:backend|server|database|api|db|accounts?|login|auth\w*)\b/gi,
    " ",
  );
}

export type DeterministicSignals = {
  clientOnly: boolean;
  /** The prompt itself says the data is mock, sample, or not really processed. */
  notReal: boolean;
  serverThing: boolean;
  authSystem: boolean;
  multiPerson: boolean;
  crossDevice: boolean;
  mentionsMongo: boolean;
};

/** The word-level reading, exported so the cases can pin each signal. */
export function readSignals(prompt: string): DeterministicSignals {
  const text = typeof prompt === "string" ? prompt : "";
  const deNegated = deNegate(text);
  return {
    clientOnly: CLIENT_ONLY_RE.test(text),
    notReal: NOT_REAL_RE.test(text),
    serverThing: SERVER_THING_RE.test(deNegated),
    authSystem: AUTH_SYSTEM_RE.test(deNegated) && !AUTH_AS_UI_RE.test(text),
    multiPerson: MULTI_PERSON_RE.test(deNegated),
    crossDevice: CROSS_DEVICE_RE.test(deNegated),
    mentionsMongo: /\bmongo(?:db)?\b/i.test(text),
  };
}

// The framework is pinned to "react" on purpose. The Next.js and TanStack Start
// E2B templates were never built — selectTemplate() still carries the TODOs for
// them and silently falls back to the Vite template, so returning either value
// produced a sandbox that could not boot: `npm run dev` with no Next.js
// installed, a readiness poll against :3000 when Vite serves :5173, and an
// expected entry point the generator was told to write but the template cannot
// serve. NEXTJS_TEMPLATE_ID/TANSTACK_TEMPLATE_ID being set is NOT a safe signal
// to re-enable on — they are populated in production but point at no real
// template. The framework words still count as a server signal above.
const FRAMEWORK: BuildClassification["framework"] = "react";

function decide(
  signals: DeterministicSignals,
  buildType: BuildClassification["buildType"],
  needsAuth: boolean,
  reason: string,
  source: BuildClassification["source"],
): BuildClassification {
  return {
    buildType,
    framework: FRAMEWORK,
    database: buildType === "fullstack" ? (signals.mentionsMongo ? "mongodb" : "supabase") : "none",
    needsAuth: buildType === "fullstack" && needsAuth,
    reason,
    source,
  };
}

/** The instruction for the judgement pass. Separate so its wording is tested. */
export const CLASSIFY_INSTRUCTION =
  "Decide whether an app needs a SERVER AND A DATABASE, or whether the browser is enough.\n\n" +
  "Answer yes to a server ONLY if at least one of these is true:\n" +
  "- more than one person uses the app and they see different data, or each other's data\n" +
  "- the data must still be there on a DIFFERENT device, browser or computer\n" +
  "- people sign in as themselves\n" +
  "- it handles money, files, email, or anything a browser cannot be trusted with\n\n" +
  "Answer no — the browser is enough — if one person uses it on one machine and " +
  "losing the data by clearing their browser would be acceptable. A single-user " +
  "notes app, a calculator, a game, a landing page, a dashboard over data typed in " +
  "by hand: all browser-only.\n\n" +
  "Do not answer yes just because a server would be nicer, more professional or " +
  "more scalable. The question is whether the app is WRONG without one.\n\n" +
  'Return JSON only: {"needsServer":true|false,"needsSignIn":true|false,"why":"one short sentence"}';

/**
 * Classify a build request.
 *
 * Deterministic on its own. Pass a dispatcher and the ambiguous middle gets one
 * cheap model call; without one it leans and says so in `source`, so a build
 * that was guessed at is never indistinguishable from one that was read.
 */
export async function classifyBuild(
  prompt: string,
  opts?: {
    dispatcher?: AgentDispatcher | undefined;
    sessionId?: string | undefined;
    userId?: string | undefined;
    projectId?: string | undefined;
    provider?: "anthropic" | "modal" | undefined;
  },
): Promise<BuildClassification> {
  const signals = readSignals(prompt);

  // ── 1. The user asked for the browser ──────────────────────────────────────
  // Absolute. A named database does NOT override it: "store it in Supabase and
  // cache in localStorage" names both, and the only safe reading of a prompt
  // that says both is the one the user can correct in a follow-up — except that
  // a named database is itself explicit, so it is checked first below.
  if (signals.clientOnly && !signals.serverThing) {
    return decide(signals, "frontend", false, "the request asks for browser-side storage", "explicit-client");
  }

  // ── 2. The user named a server ─────────────────────────────────────────────
  // "no real processing", "mock employees": the user answered it themselves.
  // Before the server layer on purpose — the words this matches are the very
  // ones being disclaimed. An explicit sign-in or cross-device requirement
  // still wins, because those cannot be mocked away.
  if (signals.notReal && !signals.authSystem && !signals.crossDevice) {
    return decide(signals, "frontend", false, "the request says this data is not real", "explicit-client");
  }
  if (signals.serverThing) {
    return decide(signals, "fullstack", signals.authSystem, "a database, backend or server-only feature is named", "explicit-server");
  }
  if (signals.authSystem) {
    return decide(signals, "fullstack", true, "people sign in as themselves", "explicit-server");
  }
  if (signals.crossDevice) {
    return decide(signals, "fullstack", false, "the data has to exist on another device", "explicit-server");
  }
  if (signals.multiPerson) {
    return decide(signals, "fullstack", signals.authSystem, "more than one person's data is involved", "explicit-server");
  }

  // ── 3. Ambiguous: ask, do not guess ────────────────────────────────────────
  if (opts?.dispatcher && opts.sessionId && opts.userId && opts.projectId) {
    try {
      const result = await opts.dispatcher.dispatch({
        agentType: "acceptance",
        usageCategory: "build",
        provider: opts.provider ?? "modal",
        task: { description: `${CLASSIFY_INSTRUCTION}\n\nThe request:\n${prompt}`, outputFormat: "json" },
        sessionId: opts.sessionId,
        userId: opts.userId,
        projectId: opts.projectId,
        costGuard: { cumulativeUsd: 0, maxUsd: 0.05 },
      });
      const parsed = parseClassification(result.finalContent || result.content);
      if (parsed) {
        return decide(
          signals,
          parsed.needsServer ? "fullstack" : "frontend",
          parsed.needsSignIn,
          parsed.why ? `read from the request: ${parsed.why}` : "read from the request",
          "model",
        );
      }
      logger.warn(
        { sessionId: opts.sessionId, head: (result.finalContent || result.content).slice(0, 200) },
        "[classify] judgement pass returned nothing usable — leaning on the words instead",
      );
    } catch (err) {
      logger.warn(
        { sessionId: opts.sessionId, err: err instanceof Error ? err.message : String(err) },
        "[classify] judgement pass failed — leaning on the words instead",
      );
    }
  }

  // ── 4. Lean, and say so ────────────────────────────────────────────────────
  // Nothing in the prompt names a server and nothing names the browser. With no
  // judgement available the browser is the honest default: inventing a database
  // for a request that never mentioned one is how the eval once found half the
  // smoke set carrying a Supabase schema it never used. `source` records that
  // this was a lean rather than a reading.
  return decide(signals, "frontend", false, "nothing in the request needs a server", "lean-client");
}

type ParsedClassification = { needsServer: boolean; needsSignIn: boolean; why: string };

/** Pure, never throws. Exported for its cases. */
export function parseClassification(raw: string): ParsedClassification | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  // A missing needsServer is NOT false — it is an unusable answer, and treating
  // it as "no server" is exactly the silent failure this file exists to stop.
  if (typeof obj["needsServer"] !== "boolean") return null;
  return {
    needsServer: obj["needsServer"],
    needsSignIn: obj["needsSignIn"] === true,
    why: typeof obj["why"] === "string" ? obj["why"].trim().slice(0, 200) : "",
  };
}
