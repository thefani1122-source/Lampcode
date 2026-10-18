import { storeCheckpoint, takeCheckpoint, type Checkpoint } from "../../verify/checkpoints.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const checkpointHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const label = typeof args["label"] === "string" ? args["label"].trim() : "";
      if (!label) return "Error: checkpoint label must not be empty.";
      if (label.length > 100) return "Error: checkpoint label must be 100 characters or fewer.";
      const checkpoints = ctx.checkpoints ?? (ctx.checkpoints = new Map<string, Checkpoint>());
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      const result = storeCheckpoint(checkpoints, takeCheckpoint(label, files));
      const notice = result.replaced
        ? ` Replaced the earlier checkpoint named "${label}".`
        : result.evicted
          ? ` The oldest checkpoint, "${result.evicted}", was evicted to make room.`
          : "";
      return `Checkpoint "${label}" saved with ${Object.keys(files).length} file(s).${notice}`;
    
};

