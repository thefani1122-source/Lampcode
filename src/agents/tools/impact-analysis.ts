import { currentProjectFiles } from "../file-deletion.js";
import { formatImpact, impactAnalysis } from "../../verify/impact.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * "If I change this, what else has to change — and what will nobody notice is
 * broken?"
 *
 * The second question is the one that earns the tool. A model renaming a field
 * routinely updates the file it is looking at and leaves four call sites and
 * the SQL behind, and nothing in the build notices until a page comes back
 * empty. The `untested` list says where a change is dangerous rather than
 * merely wide.
 */
export const impactAnalysisHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => {
  const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
  if (Object.keys(files).length === 0) {
    return "There are no project files yet. Ask about impact once code has been written.";
  }

  const symbol = typeof args["symbol"] === "string" ? args["symbol"].trim() : "";
  if (!symbol) return "Name the symbol you are about to change.";

  return formatImpact(impactAnalysis(files, symbol));
};
