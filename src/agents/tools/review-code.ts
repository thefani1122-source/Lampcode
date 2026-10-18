import { currentProjectFiles } from "../file-deletion.js";
import { reviewProject, formatReview } from "../../verify/code-review.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const reviewCodeHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      if (Object.keys(files).length === 0) {
        return "There is no code to review yet.";
      }
      if (!ctx.dispatcher || !ctx.userId) {
        return "Error: the review pass is not available in this build.";
      }
      const maxUnits = typeof args["max_files"] === "number" && args["max_files"] > 0
        ? Math.min(Math.floor(args["max_files"]), 60)
        : undefined;
      const result = await reviewProject({
        dispatcher: ctx.dispatcher,
        files,
        sessionId: ctx.sessionId ?? "",
        userId: ctx.userId,
        projectId: ctx.projectId ?? "",
        provider: ctx.provider ?? "modal",
        ...(maxUnits === undefined ? {} : { maxUnits }),
        onProgress: (done, total, path) =>
          ctx.onLog?.(`Reviewing ${done}/${total}: ${path}`),
      });
      if (ctx.review) {
        ctx.review.called = true;
        ctx.review.deep = result.coverage.deep;
        ctx.review.total = result.coverage.total;
        ctx.review.unreviewed = result.coverage.unreviewed;
        ctx.review.findings = result.findings.length;
        ctx.review.dropped = result.droppedUncorroborated;
        ctx.review.costUsd = result.costUsd;
      }
      return formatReview(result);
    
};

