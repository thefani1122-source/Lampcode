import { listProjectFiles } from "../../preview/e2b-service.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { NOT_READY, isNoSandbox } from "./shared.js";
export const listFilesHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

  const known = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);

      const inMemory = Object.keys(known).sort();
      if (inMemory.length > 0) {
        return `${inMemory.length} file(s) in the project:\n${inMemory.join("\n")}`;
      }
      try {
        const files = await listProjectFiles(projectId);
        if (files.length === 0) {
          return "The project has no source files yet — this is a new build. Write them with write_files.";
        }
        return `${files.length} file(s) in the project:\n${files.join("\n")}`;
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        return `Could not list files: ${err instanceof Error ? err.message : String(err)}. You can still write files with write_files.`;
      }
    
};

