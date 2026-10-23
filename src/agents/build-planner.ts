import { AgentDispatcher } from "./dispatcher.js";
import { generateFileManifest } from "./manifest-generator.js";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { isTemplateOwnedFile } from "../preview/e2b-service.js";
import type { BuildPlan, PlannedFile } from "../db/schema.js";

/**
 * One cheap dispatch before a long build, deciding the file layout.
 *
 * A big build used to be one long improvisation: the model started writing and
 * found out what the app was as it went. Two costs. The one-file-app habit —
 * four views, a kanban and a chart all landing in App.tsx — is what you get
 * when nobody decided on a layout first. And when the ForgeFlow build died
 * mid-repair at round 14, nothing anywhere stated what it had set out to make,
 * so there was no way to resume it or to tell which of its fifteen files were
 * still missing.
 *
 * The plan is a list of files and what each is for. Nothing else. It does not
 * design schemas, pick libraries or write code — a plan that specifies
 * everything costs as much as the build and is wrong by the second file.
 */

/** Hard ceiling on planned files, matching the planner's own instruction. A
 *  model that ignores it gets truncated rather than handed a 200-file plan. */
const MAX_PLANNED_FILES = 25;

/** Budget for the planning dispatch alone. It writes a short JSON object, so
 *  this is generous; it exists so a planner that rambles cannot eat the
 *  build's budget before any code is written. */
const PLAN_COST_CEILING_USD = 0.25;

/**
 * Does this build earn a planning pass?
 *
 * Every agentic build plans — new or edit, long prompt or four words. ONE
 * exclusion is left, and it is about plumbing rather than judgement: the
 * PIPELINE path emits a single shot of fenced files and never reads a plan, so
 * planning for it would be paid for and thrown away.
 *
 * Everything else that used to stand here — a word count, and three keyword
 * lists bolted on when the word count did not work — is gone. See the body for
 * what each of them cost.
 *
 * Pure and exported so the rule is testable without spending a build.
 */
export function shouldPlan(opts: {
  prompt: string;
  hasExistingCode: boolean;
  agenticBuild: boolean;
}): boolean {
  if (!config.BUILD_PLANNING_ENABLED) return false;
  // The pipeline path never reads a plan.
  if (!opts.agenticBuild) return false;

  // An EDIT always plans, and deliberately without a word count or a keyword
  // test in front of it.
  //
  // This used to bail on `hasExistingCode`, reasoning that an edit already has
  // a layout — the project's own. True about layout, and beside the point: the
  // planning pass is where the request gets understood, and a feature asked for
  // in one line ("add a camera so people can photograph a dish and get its
  // calories") needs that more than a long first prompt does, not less. Without
  // it the agent went straight to writing and spent ten minutes improvising a
  // feature nobody had thought through. Reported 2026-10-23.
  //
  // No heuristic decides which edits deserve it, because the heuristics below
  // are exactly what let this one through. The asymmetry is the same one the
  // comment below describes, only sharper: a plan costs about $0.05, and a
  // misunderstood feature costs the build.
  if (opts.hasExistingCode) return true;

  // EVERY build plans. The word count and the three keyword tests that used to
  // stand here are gone, and their removal is the point.
  //
  // What they cost, measured on real builds 2026-10-23: "build me a calorie
  // tracker" is five words and matches no keyword, so the request that most
  // needed working out — who logs the calories, what gets stored, does this
  // need a database at all — went straight to code with nothing decided. The
  // threshold had already been tuned twice (60, then 38) and the 2026-10-03
  // measurement across twenty eval prompts had already found that length
  // CANNOT separate complexity: editor-undo (hard) is 41 words, dashboard 46,
  // form-validation (smoke) 50. Three keyword lists were added to patch around
  // that, and a short prompt for a hard app still slipped through all of them.
  //
  // A heuristic that has been retuned twice and patched three times is not a
  // threshold, it is a guess. The asymmetry settles it: a plan costs about
  // $0.05, and a build that never worked out what it was making costs the
  // build. BUILD_PLANNING_ENABLED remains the way to turn this off.
  return true;
}

/**
 * Pull a BuildPlan out of whatever the model returned.
 *
 * Exported for its own cases. Models wrap JSON in prose and in ```json fences
 * however much the prompt says not to, and a planner whose output silently
 * fails to parse would leave long builds unplanned with nothing in the log
 * saying why.
 */
export function parsePlan(raw: string): BuildPlan | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // Take the outermost {...}. Works for a bare object, a ```json fence, and
  // "Here is the plan: {...}" alike.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const rawFiles = Array.isArray(obj["files"]) ? obj["files"] : [];

  const seen = new Set<string>();
  const files: PlannedFile[] = [];
  for (const entry of rawFiles) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const path = typeof e["path"] === "string" ? e["path"].trim().replace(/^\.?\//, "") : "";
    if (path === "") continue;
    // A plan that includes a template-owned file invites the build to try
    // writing it, be refused, and treat that as a failure. Drop them here, in
    // the one place that already knows which files those are.
    if (isTemplateOwnedFile(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const purpose = typeof e["purpose"] === "string" ? e["purpose"].trim() : "";
    files.push({ path, purpose: purpose || "no stated purpose" });
    if (files.length >= MAX_PLANNED_FILES) break;
  }

  // A plan with no files is not a plan. Returning one would put an empty
  // "planned files" block in the build prompt, which is worse than none.
  if (files.length === 0) return null;

  const summary = typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
  const approach = Array.isArray(obj["approach"])
    ? obj["approach"].filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  const outOfScope = Array.isArray(obj["outOfScope"])
    ? obj["outOfScope"].filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  return {
    summary: summary || "no summary given",
    files,
    ...(approach.length > 0 ? { approach } : {}),
    ...(outOfScope.length > 0 ? { outOfScope } : {}),
  };
}

/**
 * Render a plan as the block injected into the build's own prompt.
 *
 * Phrased as a starting point rather than a contract on purpose. The planner
 * saw only the prompt; the builder sees the running app, and when the two
 * disagree the builder is the one with evidence. A plan presented as binding
 * would make the model follow it past the point where it had learned better.
 */
export function formatPlanForPrompt(plan: BuildPlan): string {
  const lines = [
    "\n\nWHAT THE PLANNING PASS DECIDED",
    `A planning pass ran before this build. ${plan.summary}`,
  ];

  // Ahead of the file list on purpose: how the thing works is what the file
  // list is FOR, and a builder that reads only the paths rebuilds the shell
  // and leaves the middle of the app empty.
  if (plan.approach && plan.approach.length > 0) {
    lines.push(
      "",
      "How it works — build to these decisions, they are not suggestions:",
      ...plan.approach.map((a) => `- ${a}`),
    );
  }

  lines.push(
    "",
    "Write these files, in this order:",
    ...plan.files.map((f, i) => `${i + 1}. ${f.path} — ${f.purpose}`),
  );
  if (plan.outOfScope && plan.outOfScope.length > 0) {
    lines.push(
      "",
      `Deliberately out of scope: ${plan.outOfScope.join("; ")}. Do not build these.`,
    );
  }
  lines.push(
    "",
    "This is a starting point, not a contract. You can see the running app and the " +
    "planner could not, so if the layout turns out to be wrong, change it and say so in " +
    "your final reply. What you must not do is collapse it back into one large file.",
  );
  return lines.join("\n");
}

export type PlanResult = {
  plan: BuildPlan | null;
  costUsd: number;
  /** Why there is no plan, when plan is null. Logged, not shown to the model. */
  reason?: string;
};

/**
 * Run the planning dispatch. Never throws: a build must not fail because its
 * optional planning pass did, so every failure returns `plan: null` and the
 * build proceeds exactly as it would have without planning.
 */
export async function planBuild(opts: {
  dispatcher: AgentDispatcher;
  prompt: string;
  sessionId: string;
  userId: string;
  projectId: string;
  provider: "anthropic" | "modal";
  /** The project as it stands. Present on an edit, empty on a new build. */
  existingFiles?: Record<string, string>;
  /** What the pipeline has ALREADY decided, before the planner is asked
   *  anything. Without it the planner decides independently and the two
   *  contradict each other — a plan saying "no backend, mock login" against a
   *  build the classifier had already routed as fullstack. The agent then has
   *  to pick a side mid-build, which it reported out loud: "I see there's a
   *  conflict: the planning pass says no backend with localStorage, but…".
   *  Seen 2026-10-23. */
  shape?: { fullstack: boolean; databaseConnected: boolean };
}): Promise<PlanResult> {
  // A plan for a change has to be made against the app that exists, or it is
  // guesswork about which files to touch. The manifest is paths and purposes
  // only — the planner is not allowed to write code and does not need to read
  // it to decide what a change requires.
  const existing = opts.existingFiles ?? {};
  const parts = [opts.prompt];

  if (opts.shape) {
    parts.push(
      "",
      "ALREADY DECIDED — plan within this, do not contradict it:",
      opts.shape.fullstack
        ? "- This build HAS a real backend. Do not plan around localStorage as the store of record, and do not mock away anything the backend should do."
        : "- This build is frontend-only. Do not plan a server or an API of your own.",
      opts.shape.databaseConnected
        ? "- A real database is connected. Data belongs in it, and anything behind a sign-in must be genuinely protected — a login that accepts any password is not a feature, it is a hole."
        : "- No database is connected, so persistence is local to the browser. Say so plainly in approach rather than implying accounts are real.",
    );
  }

  if (Object.keys(existing).length > 0) {
    parts.push("", "EXISTING FILES:", generateFileManifest(existing));
  }

  const description = parts.join("\n");

  try {
    const result = await opts.dispatcher.dispatch({
      agentType: "planning",
      usageCategory: "build",
      provider: opts.provider,
      task: {
        description,
        outputFormat: "json",
      },
      sessionId: opts.sessionId,
      userId: opts.userId,
      projectId: opts.projectId,
      // No tools: this pass decides a layout from the prompt alone. There is
      // no sandbox worth reading yet, and giving it tools would turn a cheap
      // single call into its own agentic loop.
      costGuard: { cumulativeUsd: 0, maxUsd: PLAN_COST_CEILING_USD },
    });

    const plan = parsePlan(result.finalContent || result.content);
    if (!plan) {
      logger.warn(
        { sessionId: opts.sessionId, contentHead: (result.finalContent || result.content).slice(0, 300) },
        "[planner] could not parse a plan — building without one",
      );
      return { plan: null, costUsd: result.costUsd, reason: "unparseable plan" };
    }

    logger.info(
      { sessionId: opts.sessionId, files: plan.files.length, costUsd: result.costUsd },
      "[planner] plan ready",
    );
    return { plan, costUsd: result.costUsd };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: opts.sessionId, err: reason }, "[planner] planning dispatch failed — building without a plan");
    return { plan: null, costUsd: 0, reason };
  }
}
