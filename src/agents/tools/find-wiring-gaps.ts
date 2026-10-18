import { findWiringGaps, formatWiringGaps } from "../../verify/wiring.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const findWiringGapsHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      if (Object.keys(files).length === 0) {
        return (
          "There are no files to analyse yet. Call this once the pages and controls exist, " +
          "not before."
        );
      }
      return formatWiringGaps(findWiringGaps(files));
    
};

