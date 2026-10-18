import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const readProjectFileHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    const file = ctx.contextFiles?.find((f) => f.path === path);
    return file ? file.content : `Error: "${path}" is not part of this project's current context.`;
  
};

