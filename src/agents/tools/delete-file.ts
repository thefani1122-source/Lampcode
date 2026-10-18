import { commitFileDeletion, currentProjectFiles, planFileDeletions } from "../file-deletion.js";
import { writeFilesToSandbox, isTemplateOwnedFile, deleteProjectFileFromSandbox } from "../../preview/e2b-service.js";
import { deletePersistedProjectFile } from "../../storage/project-files.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { noteChurn, noteWrite } from "./shared.js";
export const deleteFileHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      const raw = Array.isArray(args["paths"]) ? args["paths"] : [];
      const paths = raw.filter((path): path is string => typeof path === "string");
      if (paths.length === 0) return "No valid file paths were provided.";

      if (!ctx.deletedFiles) ctx.deletedFiles = new Set<string>();
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      const decisions = planFileDeletions(paths, files, isTemplateOwnedFile);
      const lines: string[] = [];
    for (const decision of decisions) {
        if (decision.status === "missing") {
          lines.push(`${decision.path}: already absent; nothing to delete.`);
          continue;
        }
        if (decision.status === "template-owned") {
          lines.push(`${decision.path}: refused because it belongs to the project template.`);
          continue;
        }
        if (decision.status === "entry-point") {
          lines.push(`${decision.path}: refused because it is a required app entry point.`);
          continue;
        }
        if (decision.status === "unsafe-path") {
          lines.push(`${decision.path || "(empty path)"}: refused because it is not a safe project-relative path.`);
          continue;
        }

        let sandboxRemoved = false;
        try {
          // Do not publish the tombstone until both copies have been removed. If
          // either side fails, the path remains current and can be retried.
          await deleteProjectFileFromSandbox(projectId, decision.path);
          sandboxRemoved = true;
          await deletePersistedProjectFile(projectId, decision.path);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (sandboxRemoved && decision.before !== undefined) {
            try {
              await writeFilesToSandbox(projectId, { [decision.path]: decision.before }, ctx.onLog);
            } catch (restoreErr) {
              const restoreReason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
              lines.push(`${decision.path}: INCOMPLETE — ${reason}. The live copy could not be restored (${restoreReason}); the file is not recorded as deleted.`);
              continue;
            }
          }
          lines.push(`${decision.path}: INCOMPLETE — ${reason}. It is not recorded as deleted.`);
          continue;
        }

      commitFileDeletion(
        decision.path,
        decision.before ?? "",
        ctx.generatedFiles,
        ctx.deletedFiles,
        (before, after, kind) => noteChurn(ctx, before, after, kind),
        () => noteWrite(ctx),
      );
      lines.push(`${decision.path}: deleted from the live project and stored copy.`);
    }

    return lines.join("\n");
    
};

