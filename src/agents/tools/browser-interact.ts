import { runJourney } from "../../preview/e2b-service.js";
import { formatJourney, hasJourneyForCurrentCode, parseJourney } from "../../verify/journey.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Drive the app the way a person would (B6+).
 *
 * `check_page` asks whether a page rendered. The interaction probe asks whether
 * anything responds when each control is clicked, across every route,
 * automatically — and neither of them knows what the app is FOR. Only a
 * scripted journey can answer the question the user actually asked: add an
 * item, reload, is it still there.
 *
 * The steps are validated before a browser starts, so a malformed journey
 * costs nothing and comes back with a sentence saying what to fix.
 */
export const browserInteractHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => {
  const projectId = ctx.projectId;
  if (!projectId) return "Error: no project sandbox is attached to this build.";

  const parsed = parseJourney(args["steps"]);
  if ("error" in parsed) return `Error: ${parsed.error}`;

  const previous = ctx.journeyEvidence?.value ?? null;
  const currentWriteCount = ctx.writeCounter?.value ?? 0;
  if (previous && hasJourneyForCurrentCode(previous, currentWriteCount)) {
    return [
      "A browser journey has already run against this unchanged file revision. Repeating it is blocked to avoid spending another browser/model round on identical code.",
      "Use the previous report below. If a step failed, inspect and repair the application first; a new journey is allowed after a file write.",
      formatJourney(previous.report),
    ].join("\n\n");
  }

  const report = await runJourney(projectId, parsed.steps);
  if (ctx.journeyEvidence) {
    ctx.journeyEvidence.value = {
      steps: parsed.steps,
      report,
      writeCountAtRun: ctx.writeCounter?.value ?? 0,
    };
  }
  return formatJourney(report);
};
