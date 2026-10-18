import { findDeadCode, tallyDeadCode, formatDeadCode } from "../../verify/dead-code.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const findDeadCodeHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      if (Object.keys(files).length === 0) {
        return (
          "There are no files to analyse yet. Call this after you have written or changed " +
          "code, not before."
        );
      }
      const findings = findDeadCode(files);
      if (ctx.deadCode) {
        const t = tallyDeadCode(findings);
        ctx.deadCode.unusedImports = t.unusedImports;
        ctx.deadCode.unreferencedExports = t.unreferencedExports;
        ctx.deadCode.neverRendered = t.neverRendered;
        ctx.deadCode.called = true;
      }
      return formatDeadCode(findings);
    
};

