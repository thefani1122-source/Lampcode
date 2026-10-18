import { logger } from "../server/logger.js";
import type { AgentDispatcher } from "../agents/dispatcher.js";

/**
 * What could go wrong in THIS app, derived from what the person asked for.
 *
 * `security.ts` asks the questions that are the same for every app: is there
 * auth middleware, is RLS on, is a key committed, is CORS wide open. Those are
 * worth asking and they are not the dangerous ones. The dangerous ones are
 * specific:
 *
 *   "a clinic booking app"   → only the patient and their own clinician may
 *                              read an appointment
 *   "a team expense tracker" → an employee may submit a claim and may not
 *                              approve their own
 *   "a public poll"          → anyone may vote once; nobody may see who voted
 *                              for what
 *
 * No pattern matcher knows any of that, because none of it is in the code's
 * shape — it is in the sentence the person typed. So this is the
 * completion-audit's trick applied to security: a pass that CANNOT WRITE CODE
 * turns the request into checkable claims, and something else then tries to
 * prove or break them.
 *
 * This module is the first half only. It extracts and it filters; verifying
 * (G3) is separate, and the static part of that shipped on 2026-10-18 as
 * `checkRlsScoping`.
 *
 * THE FAILURE THIS IS DESIGNED AGAINST is not a missing threat — it is a list
 * of twelve true, useless sentences. Ask any model for security requirements
 * and it will offer "use HTTPS", "validate all user input", "hash passwords",
 * "prevent SQL injection". Every one is correct, every one is already covered
 * or irrelevant, and a list of them buries the one requirement that actually
 * belongs to this app. `isGenericThreat` below is a deterministic filter that
 * throws those away, so the specificity PLAN asks for — "different prompts
 * produce genuinely different checks" — is partly enforced without an LLM in
 * the loop at all.
 */

export type ThreatKind =
  /** Who may read or change which rows. The category RLS exists for. */
  | "access"
  /** What the server must refuse to accept. */
  | "input"
  /** What must never leave the server, or reach the wrong screen. */
  | "exposure"
  /** What one person must not be able to do repeatedly or at scale. */
  | "abuse";

export type ThreatRequirement = {
  id: string;
  /** One checkable sentence, in the app's own nouns. */
  statement: string;
  kind: ThreatKind;
};

const VALID_KINDS = new Set<string>(["access", "input", "exposure", "abuse"]);

/** Enough to be worth checking, few enough to stay readable and affordable. */
const MAX_THREATS = 8;
const EXTRACT_COST_CEILING_USD = 0.1;

/**
 * Boilerplate every model reaches for, and which belongs to `security.ts` or
 * nowhere.
 *
 * This is a denylist of known-generic sentences rather than a "specificity
 * score", on purpose. A score is a number nobody can argue with and everybody
 * has to tune; a denylist is a list someone can read, disagree with, and
 * correct. When this rejects something it should be obvious why.
 */
const GENERIC_PATTERNS: RegExp[] = [
  /\buse\s+https\b|\benforce\s+https\b|\bssl\/tls\b/i,
  /\bvalidate\s+(all\s+)?(user\s+)?input\b(?!.*\b(field|email|amount|date|file|quantity|price)\b)/i,
  /\bsanitiz\w+\s+(all\s+)?(user\s+)?input\b/i,
  // Password storage advice, in either order: "plain-text password" and
  // "passwords in plain text" are the same sentence and both turn up.
  /\bhash\w*\s+password|\bbcrypt\b|\bstore\s+passwords?\s+securely\b/i,
  /\bpasswords?\b[^.]{0,30}\bplain\s*-?\s*text\b|\bplain\s*-?\s*text\b[^.]{0,30}\bpasswords?\b/i,
  /\b(prevent|avoid|protect against)\s+(sql\s*injection|xss|cross[- ]site|csrf|clickjacking)\b/i,
  /\buse\s+environment\s+variables?\b|\bdo\s*n[o']?t\s+commit\s+secrets?\b|\bhard-?cod\w+\s+secrets?\b/i,
  /\benable\s+(rls|row[- ]level\s+security)\b/i,
  /\b(add|implement|require)\s+authentication\b(?!.*\b(before|to\s+(the|a)\s+\w+)\b)/i,
  /\bimplement\s+rate\s+limiting\b(?!.*\b(per|on|for)\b)/i,
  /\bkeep\s+dependencies\s+up\s*-?\s*to\s*-?\s*date\b|\bsecurity\s+headers?\b/i,
  /\bprinciple\s+of\s+least\s+privilege\b|\bdefense\s+in\s+depth\b/i,
  /\blog\s+security\s+events?\b|\baudit\s+log\w*\b(?!.*\b(only|visible|readable)\b)/i,
];

/**
 * True when a statement is the generic advice above rather than something
 * about this app. Exported so the rule is testable and arguable on its own.
 */
export function isGenericThreat(statement: string): boolean {
  const s = statement.trim();
  if (s.length === 0) return true;
  return GENERIC_PATTERNS.some((re) => re.test(s));
}

/**
 * Parse the extraction pass's JSON. Pure, and never throws: a build must not
 * fail because its threat model did.
 *
 * Mirrors `parseCriteria` deliberately — same renumbering, same dedupe, same
 * cap-with-a-count. A second shape for the same job is a second place to be
 * wrong.
 */
export function parseThreats(raw: string, stats?: { dropped: number; generic: number }): ThreatRequirement[] {
  const text = raw.trim();
  if (text.length === 0) return [];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const rawList = (parsed as Record<string, unknown>)["threats"];
  if (!Array.isArray(rawList)) return [];

  const out: ThreatRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const statement = typeof e["statement"] === "string" ? e["statement"].trim() : "";
    if (statement === "") continue;

    // Counted, not silently dropped. "The model returned twelve and we kept
    // one" is a fact worth seeing in a log — it says the extraction prompt is
    // not doing its job, which no amount of filtering fixes.
    if (isGenericThreat(statement)) {
      if (stats) stats.generic += 1;
      continue;
    }

    const key = statement.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);

    const rawKind = typeof e["kind"] === "string" ? e["kind"].trim().toLowerCase() : "";
    const kind = VALID_KINDS.has(rawKind) ? (rawKind as ThreatKind) : "access";
    // Renumbered rather than trusting the model's ids, for the reason
    // parseCriteria gives: a duplicated or skipped id makes a later mapping
    // drop one quietly, and nothing here may go missing quietly.
    out.push({ id: `T${out.length + 1}`, statement, kind });

    if (out.length >= MAX_THREATS) {
      if (stats) {
        const rest = rawList.slice(rawList.indexOf(entry) + 1);
        for (const r of rest) {
          if (typeof r !== "object" || r === null) continue;
          const t = (r as Record<string, unknown>)["statement"];
          if (typeof t === "string" && t.trim() !== "" && !isGenericThreat(t)) stats.dropped += 1;
        }
      }
      break;
    }
  }
  return out;
}

export type ThreatExtractResult = {
  threats: ThreatRequirement[];
  costUsd: number;
  reason?: string;
  /** Specific threats the cap discarded — coverage is partial when non-zero. */
  dropped?: number;
  /** Generic boilerplate thrown away. High means the prompt is not working. */
  generic?: number;
};

/** The instruction. Separate and exported so its wording is covered by cases. */
export const THREAT_EXTRACTION_INSTRUCTION =
  "You are reading a request for an app and listing what must NOT be possible in it. " +
  "You are not writing code and you will not be asked to.\n\n" +
  "Rules:\n" +
  "- Every line must be about THIS app, in ITS nouns. If the sentence would fit any app, " +
  "it is wrong and you must leave it out.\n" +
  "- Name the actor, the thing, and the action: WHO must not do WHAT to WHICH data.\n" +
  "- Do NOT write generic advice. Specifically forbidden: use HTTPS, validate input, hash " +
  "passwords, prevent SQL injection or XSS, keep secrets in environment variables, enable RLS, " +
  "add authentication, keep dependencies updated. All of those are already checked elsewhere " +
  "and listing them buries the ones that matter.\n" +
  "- Prefer the rule that would be most damaging to get wrong.\n" +
  "- At most 8. Fewer, sharper lines are better than a long list.\n\n" +
  "Good: \"A clinician may only read appointments for patients assigned to them.\"\n" +
  "Good: \"An employee may submit an expense claim but may not approve their own.\"\n" +
  "Bad:  \"Validate all user input.\" (generic)\n" +
  "Bad:  \"Use HTTPS everywhere.\" (generic, and not ours to decide)\n\n" +
  'Return JSON only: {"threats":[{"statement":"...","kind":"access|input|exposure|abuse"}]}';

/**
 * Turn the request into things that must not be possible. Never throws — a
 * build must not fail because its threat model did, so every failure path
 * returns no threats and the build proceeds with the generic checks alone.
 */
export async function extractThreats(opts: {
  dispatcher: AgentDispatcher;
  /** The RAW prompt. The expanded one would model threats against our own
   *  additions rather than against what the person asked for. */
  prompt: string;
  sessionId: string;
  userId: string;
  projectId: string;
  provider: "anthropic" | "modal";
}): Promise<ThreatExtractResult> {
  try {
    const result = await opts.dispatcher.dispatch({
      agentType: "acceptance",
      usageCategory: "build",
      provider: opts.provider,
      task: {
        description: `${THREAT_EXTRACTION_INSTRUCTION}\n\nThe request:\n${opts.prompt}`,
        outputFormat: "json",
      },
      sessionId: opts.sessionId,
      userId: opts.userId,
      projectId: opts.projectId,
      costGuard: { cumulativeUsd: 0, maxUsd: EXTRACT_COST_CEILING_USD },
    });

    const stats = { dropped: 0, generic: 0 };
    const threats = parseThreats(result.finalContent || result.content, stats);

    if (stats.generic > 0) {
      logger.warn(
        { sessionId: opts.sessionId, kept: threats.length, generic: stats.generic },
        "[threats] generic boilerplate discarded — if this is most of them, the extraction prompt is not working",
      );
    }
    if (threats.length === 0) {
      logger.warn(
        { sessionId: opts.sessionId, generic: stats.generic, head: (result.finalContent || result.content).slice(0, 300) },
        "[threats] nothing app-specific extracted — this build gets the generic checks only",
      );
      return { threats: [], costUsd: result.costUsd, reason: "no app-specific threats parsed", generic: stats.generic };
    }
    return { threats, costUsd: result.costUsd, dropped: stats.dropped, generic: stats.generic };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: opts.sessionId, err: reason }, "[threats] extraction failed");
    return { threats: [], costUsd: 0, reason };
  }
}

/** For the model that is about to build the thing. */
export function formatThreatsForModel(threats: ThreatRequirement[]): string {
  if (threats.length === 0) return "";
  return (
    "MUST NOT BE POSSIBLE IN THIS APP — each of these will be checked:\n" +
    threats.map((t) => `- [${t.kind}] ${t.statement}`).join("\n")
  );
}

/**
 * For the person. Deliberately framed as what was UNDERSTOOD rather than what
 * was guaranteed — nothing here has been verified at this point, and the
 * completion audit's whole lesson is that saying "secure" before proving it is
 * how a build reads as finished while being nothing of the kind.
 */
export function formatThreatsForUser(threats: ThreatRequirement[]): string[] {
  if (threats.length === 0) return [];
  return [
    `I will also watch for ${threats.length} thing(s) that must not be possible in this app:`,
    ...threats.map((t) => `• ${t.statement}`),
  ];
}
