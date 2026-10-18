import { unifiedDiff } from "../../verify/diff.js";
import { formatUnknownCheckpoint } from "../../verify/checkpoints.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const diffSinceHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      if (Object.hasOwn(args, "checkpoint") && typeof args["checkpoint"] !== "string") {
        return "Error: checkpoint must be an exact checkpoint label string.";
      }
      const checkpointLabel = typeof args["checkpoint"] === "string"
        ? args["checkpoint"]
        : undefined;
      let before: Record<string, string>;
      let basis: string;
      if (checkpointLabel !== undefined) {
        const checkpoint = ctx.checkpoints?.get(checkpointLabel);
        if (!checkpoint) {
          return formatUnknownCheckpoint(checkpointLabel, [...(ctx.checkpoints?.keys() ?? [])]);
        }
        before = checkpoint.files;
        basis = `Diff since checkpoint "${checkpointLabel}":`;
      } else {
        before = ctx.projectFiles ?? {};
        basis = "Diff since build start:";
      }
      const current = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      const result = unifiedDiff(before, current, {
        ...(typeof args["context"] === "number" ? { context: args["context"] } : {}),
        ...(typeof args["max_chars"] === "number" ? { maxChars: args["max_chars"] } : {}),
      });
      return `${basis}\n${result.text}`;
    
};

