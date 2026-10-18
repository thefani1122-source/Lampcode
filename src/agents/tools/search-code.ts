import { currentProjectFiles } from "../file-deletion.js";
import { formatSearchHits, searchFiles } from "../../verify/search.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const searchCodeHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      if (Object.keys(files).length === 0) {
        return "There are no project files to search yet. Search after code has been written.";
      }
      const query = typeof args["query"] === "string" ? args["query"] : "";
      return formatSearchHits(searchFiles(files, {
        query,
        isRegex: args["is_regex"] === true,
        ...(typeof args["path_glob"] === "string" ? { pathGlob: args["path_glob"] } : {}),
        ...(typeof args["max_results"] === "number" ? { maxResults: args["max_results"] } : {}),
      }));
    
};

