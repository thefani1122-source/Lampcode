import { AgentDispatcher } from "./dispatcher.js";
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
 * Only new builds, only in agentic mode, and only when the request is actually
 * large. Each exclusion is deliberate:
 *  - An EDIT already has a file layout — the project's own. Planning one again
 *    would invite the model to restructure a working app, which is the exact
 *    opposite of what an edit should do.
 *  - The PIPELINE path emits one shot of fenced files and never reads a plan,
 *    so planning for it would be paid for and thrown away.
 *  - A SMALL build does not need a plan and should not pay for one. "Build me
 *    a counter" has one sensible layout and the model already knows it.
 *
 * Pure and exported so the threshold is testable without spending a build.
 */
export function shouldPlan(opts: {
  prompt: string;
  hasExistingCode: boolean;
  agenticBuild: boolean;
  minWords?: number;
}): boolean {
  if (!config.BUILD_PLANNING_ENABLED) return false;
  if (opts.hasExistingCode) return false;
  if (!opts.agenticBuild) return false;

  const words = opts.prompt.trim().split(/\s+/).filter(Boolean).length;
  return words >= (opts.minWords ?? config.BUILD_PLAN_MIN_WORDS);
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
  const outOfScope = Array.isArray(obj["outOfScope"])
    ? obj["outOfScope"].filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  return {
    summary: summary || "no summary given",
    files,
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
    "\n\nPLANNED FILE LAYOUT",
    `A planning pass ran before this build and decided the layout below. ${plan.summary}`,
    "",
    "Write these files, in this order:",
    ...plan.files.map((f, i) => `${i + 1}. ${f.path} — ${f.purpose}`),
  ];
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
}): Promise<PlanResult> {
  try {
    const result = await opts.dispatcher.dispatch({
      agentType: "planning",
      usageCategory: "build",
      provider: opts.provider,
      task: {
        description: opts.prompt,
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
