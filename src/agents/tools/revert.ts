import { applyCheckpointToState, formatRestorePlan, formatUnknownCheckpoint, restorePlan, restoreCheckpointPathState, snapshotCheckpointPathState, type Checkpoint } from "../../verify/checkpoints.js";
import { currentProjectFiles } from "../file-deletion.js";
import { writeFilesToSandbox, deleteProjectFileFromSandbox } from "../../preview/e2b-service.js";
import { deletePersistedProjectFile, persistFilesStrictly } from "../../storage/project-files.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { noteChurn, noteWrite } from "./shared.js";
export const revertHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const label = typeof args["label"] === "string" ? args["label"].trim() : "";
      if (!label) return "Error: checkpoint label must not be empty.";
      const checkpoint = ctx.checkpoints?.get(label);
      if (!checkpoint) return formatUnknownCheckpoint(label, [...(ctx.checkpoints?.keys() ?? [])]);
      const projectId = ctx.projectId;
      if (!projectId) return "Error: no project sandbox is attached to this build.";

      const current = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      const plan = restorePlan(checkpoint, current);
      if (plan.toWrite.length + plan.toDelete.length === 0) {
        return `${formatRestorePlan(plan)} Checkpoint "${label}" is still available.`;
      }

      // Capture content, generated-file presence, and tombstone state before side effects.
      const memoryBefore = new Map<string, ReturnType<typeof snapshotCheckpointPathState>>();
      for (const path of [...plan.toWrite, ...plan.toDelete]) {
        memoryBefore.set(path, snapshotCheckpointPathState(path, ctx.generatedFiles, ctx.deletedFiles));
      }
      const restorePaths: Array<[string, string | undefined]> = [
        ...plan.toWrite.map((path): [string, string | undefined] => [path, checkpoint.files[path]!]),
        ...plan.toDelete.map((path): [string, string | undefined] => [path, undefined]),
      ];
      const attempted: string[] = [];
      let failure: string | undefined;
      for (const [path, content] of restorePaths) {
        attempted.push(path);
        try {
          if (content === undefined) {
            await deleteProjectFileFromSandbox(projectId, path);
            await deletePersistedProjectFile(projectId, path);
          } else {
            await writeFilesToSandbox(projectId, { [path]: content }, ctx.onLog);
            await persistFilesStrictly(projectId, { [path]: content });
          }
        } catch (err) {
          failure = `${path}: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }

      if (failure !== undefined) {
        const rollbackFailures: string[] = [];
        for (const path of attempted.reverse()) {
          const before = current[path];
          try {
            if (before === undefined) await deleteProjectFileFromSandbox(projectId, path);
            else await writeFilesToSandbox(projectId, { [path]: before }, ctx.onLog);
          } catch (err) {
            rollbackFailures.push(`${path} live copy: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            if (before === undefined) await deletePersistedProjectFile(projectId, path);
            else await persistFilesStrictly(projectId, { [path]: before });
          } catch (err) {
            rollbackFailures.push(`${path} stored copy: ${err instanceof Error ? err.message : String(err)}`);
          }
          // In-memory state is committed only after all paths succeed.
          restoreCheckpointPathState(
            path,
            memoryBefore.get(path)!,
            ctx.generatedFiles,
            ctx.deletedFiles ?? (ctx.deletedFiles = new Set<string>()),
          );
        }
        const rollback = rollbackFailures.length === 0
          ? "The pre-revert files were restored."
          : `Rollback was incomplete: ${rollbackFailures.join("; ")}.`;
        return `INCOMPLETE — checkpoint "${label}" was not restored. ${failure} ${rollback} The checkpoint remains available.`;
      }

      const generatedFiles = ctx.generatedFiles ?? (ctx.generatedFiles = {});
      const deletedFiles = ctx.deletedFiles ?? (ctx.deletedFiles = new Set<string>());
      applyCheckpointToState(checkpoint.files, ctx.projectFiles, generatedFiles, deletedFiles, plan);
      for (const path of plan.toWrite) {
        const before = current[path];
        noteChurn(ctx, before ?? "", checkpoint.files[path]!, before === undefined ? "created" : "replaced");
      }
      for (const path of plan.toDelete) noteChurn(ctx, current[path]!, "", "deleted");
      noteWrite(ctx);
      return `${formatRestorePlan(plan)} Reverted to "${label}". The checkpoint remains available.`;
    
};

