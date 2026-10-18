import { readProjectFile } from "../../preview/e2b-service.js";
import { currentProjectFiles } from "../file-deletion.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { NOT_READY, isNoSandbox } from "./shared.js";
export const readFileHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

  const known = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);

      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (!path) return "Error: `path` is required.";
      const inMemory = known[path] ?? known[path.replace(/^\.\//, "")];
      if (inMemory !== undefined) {
        return inMemory.trim() === "" ? `${path} exists but is empty.` : `${path}:\n${inMemory}`;
      }
      try {
        const content = await readProjectFile(projectId, path);
        if (content.trim() === "") return `${path} exists but is empty.`;
        return `${path}:\n${content}`;
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        // Covers both "refused" (see safeProjectPath) and a genuine miss. Says
        // what to do next rather than just failing, so a wrong guess at a path
        // costs one turn instead of derailing the build.
        return (
          `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Call list_files to see what the project actually contains.`
        );
      }
    
};

