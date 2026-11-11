import { AgentDispatcher } from "./dispatcher.js";
import { generateFileManifest } from "./manifest-generator.js";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { isTemplateOwnedFile } from "../preview/e2b-service.js";
import type { BuildPlan, PlannedFile } from "../db/schema.js";

/**
 * One bounded planning dispatch before an agentic build or edit.
 *
 * It produces a concise product blueprint (screens, journeys, data behaviour,
 * visual direction and verification outcomes) plus a proposed file map. The
 * blueprint keeps the generator from improvising the product while it writes;
 * the file map discourages a one-file app without pretending to be an immutable
 * implementation manifest. The generator still has to inspect the live project
 * and verify the result.
 */

/** Hard ceiling on planned files, matching the planner's own instruction. A
 *  model that ignores it gets truncated rather than handed a 200-file plan. */
const MAX_PLANNED_FILES = 25;
/**
 * Trusted build context shared by the planner and the code generator.
 * Existing-project edits are distinct from new frontend builds because the
 * fresh-build classifier deliberately does not run on edits.
 */
export type PlanningBuildShape = {
  projectMode: "new-frontend" | "new-fullstack" | "existing-project";
  framework: "react" | "nextjs" | "tanstack" | "unknown";
  database: "browser" | "supabase" | "mongodb" | "unknown";
  backendRuntime: "none" | "node" | "python" | "unknown";
  databaseAccess:
    | "not-applicable"
    | "user-connected"
    | "declined"
    | "not-confirmed"
    | "preserve-existing"
    | "unknown";
  auth: "required" | "not-required" | "not-applicable" | "preserve-existing";
  existingBackendArtifacts: boolean;
};

/** Infer only what loaded source proves. Missing keywords do not prove a browser-only app. */
export function inferExistingDatabase(
  files: Record<string, string>,
): "supabase" | "mongodb" | "unknown" {
  const source = Object.entries(files)
    .map(([path, content]) => path + "\n" + content)
    .join("\n");
  if (/MONGODB_URI|mongodb(?:\+srv)?:\/\/|from\s+["']mongoose["']|mongoose\.connect/i.test(source)) {
    return "mongodb";
  }
  if (/@supabase\/supabase-js|SUPABASE_URL|SUPABASE_ANON_KEY|supabase\.from\(/i.test(source)) {
    return "supabase";
  }
  return "unknown";
}

/** State authoritative build/runtime facts without inventing persistence guarantees. */
export function formatBuildShapeForPrompt(shape: PlanningBuildShape): string {
  const lines = [
    "",
    "AUTHORITATIVE BUILD CONTEXT — decided by the build pipeline, not by the planning model",
  ];

  if (shape.projectMode === "new-frontend") {
    lines.push(
      "- Project mode: new frontend-only application.",
      "- Framework: " + shape.framework + ".",
      "- No application server or database is part of this build. Do not add one just because it seems more professional.",
      "- Data scope: browser-local only when the user's requested behaviour needs persistence. Do not describe browser storage as multi-user or cross-device storage.",
    );
  } else if (shape.projectMode === "new-fullstack") {
    lines.push(
      "- Project mode: new full-stack application. A real server-side implementation is required by the build pipeline; do not generate a browser-only substitute.",
      "- Framework: " + shape.framework + ".",
      "- Backend runtime: " + shape.backendRuntime + ".",
      "- Database provider selected by the build pipeline: " + shape.database + ". Do not silently switch providers.",
      "- Authentication requirement: " + shape.auth + ".",
    );
    if (shape.databaseAccess === "user-connected") {
      lines.push("- The user's own database connection is confirmed. Use the selected provider and keep the real database as the source of truth.");
    } else if (shape.databaseAccess === "declined") {
      lines.push(
        "- The user explicitly declined database setup. Be truthful: do not claim entered data persists, do not fabricate database rows, and do not silently substitute localStorage as if it were the requested database. Keep persistence-limited states explicit.",
      );
    } else if (shape.databaseAccess === "not-confirmed") {
      lines.push(
        "- A user-owned database connection is not confirmed. Do not claim database writes work. Preserve the selected server/data architecture, use only credentials genuinely available to the runtime, and show an honest unconfigured/error state if the database cannot be reached. Do not fake persistence with localStorage.",
      );
    } else {
      lines.push(
        "- Database access was not established by this planning context. Do not infer that it is connected; preserve the selected provider and avoid claims of persistence without runtime evidence.",
      );
    }
  } else {
    lines.push(
      "- Project mode: edit an existing application, not a new app.",
      "- Existing framework: " + shape.framework + ". Preserve the current framework and project conventions.",
      "- Existing backend artifacts in the loaded project files: " + (shape.existingBackendArtifacts ? "yes" : "not found") + ". Not found does NOT prove the whole application is frontend-only; it may use remote APIs or files outside the selected context.",
      "- Existing data provider: " + shape.database + ". If unknown, inspect the existing data client and project files before deciding. Preserve the current data source; do not switch to localStorage or another provider unless the user explicitly requests a migration.",
      "- Backend runtime in the loaded project: " + shape.backendRuntime + ". Preserve it where present; do not introduce a parallel server.",
      "- Authentication and authorization: preserve the existing implementation and its security boundaries unless the user explicitly asks to change them.",
    );
  }

  lines.push(
    "- Priority: the user's original request and the existing project's proven architecture outrank any assumptions made by the planner.",
  );
  return lines.join("\n");
}


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
      "Planned product decisions — implement these outcomes unless a higher-priority user/runtime constraint conflicts:",
      ...plan.approach.map((a) => `- ${a}`),
    );
  }

  lines.push(
    "",
    "Suggested file decomposition (add or adapt files required by the actual framework/project):",
    ...plan.files.map((f, i) => `${i + 1}. ${f.path} — ${f.purpose}`),
  );
  if (plan.outOfScope && plan.outOfScope.length > 0) {
    lines.push(
      "",
      `Planner-suggested out-of-scope items: ${plan.outOfScope.join("; ")}. Do not add these unless the original user request explicitly requires them.`,
    );
  }
  lines.push(
    "",
    "IMPLEMENTATION PRIORITIES:",
    "- Treat the approach above as the planned product outcome: implement its named screens, primary user journeys, data rules and visual direction. Do not silently omit a screen or workflow because the file list is incomplete.",
    "- The user's original request, explicit acceptance requirements, this build's authoritative runtime/framework context, and the existing project's proven conventions take priority over any planner assumption. If the approach conflicts with one of those, follow the higher-priority source and preserve the conflict in the build notes rather than guessing.",
    "- The file list is a proposed decomposition, not an exhaustive or immutable manifest. Add framework-required files, preserve existing files, and adjust paths when the actual project structure requires it. Do not collapse a multi-screen product into one large file.",
    "- Planner out-of-scope items must never be used to drop something the user explicitly requested.",
    "- Verify the resulting screens and primary journeys in the running application; a plan is not proof that the feature exists.",
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
  /** Trusted architecture/runtime facts. Existing-project edits must not
   *  be described as frontend-only just because the fresh-build classifier
   *  did not run; lack of a user-owned DB must not imply localStorage. */
  shape?: PlanningBuildShape;
}): Promise<PlanResult> {
  // A plan for a change has to be made against the app that exists, or it is
  // guesswork about which files to touch. The manifest is paths and purposes
  // only — the planner is not allowed to write code and does not need to read
  // it to decide what a change requires.
  const existing = opts.existingFiles ?? {};
  const parts = [opts.prompt];

  parts.push(
    "",
    "COMPLETE PRODUCT BLUEPRINT — decide these before listing files:",
    "- Screens and navigation: name every view/route, its purpose, and the major visible sections/components on it.",
    "- User journeys: describe the main end-to-end flows step by step (create, read, update, delete, search, filter, review, submit, approve, etc. as applicable).",
    "- Data model: identify entities, relationships, derived metrics, validation rules, and the single source of truth for each piece of state.",
    "- Data state: decide which data is real backend data versus local/mock preview data; define first-run, loading, error and genuinely-empty states. For collection/dashboard products, seed realistic frontend/mock preview records when appropriate; do not invent record lists for auth-only, landing, calculator, form-only or creative-canvas products, and never fake a real backend.",
    "- Visual direction: choose a product-appropriate visual identity, palette, typography, spacing scale, page shell, navigation, card/table/chart hierarchy and reusable component patterns. Avoid a generic unstyled shell.",
    "- Responsive behavior: state how navigation, grids, tables, forms and sidebars adapt to mobile and desktop.",
    "- Verification: list the observable result for each main journey and screen so the finished preview can be checked against the user's request.",
    "Put concise decisions in the approach array. A file list by itself is not a complete plan.",
  );

  if (opts.shape) {
    parts.push(formatBuildShapeForPrompt(opts.shape));
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
