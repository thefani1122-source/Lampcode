import { runJourney } from "../../preview/e2b-service.js";
import { formatJourney, parseJourney } from "../../verify/journey.js";
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

  const report = await runJourney(projectId, parsed.steps);
  return formatJourney(report);
};
