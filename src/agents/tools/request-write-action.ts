import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const requestWriteActionHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
    const service = typeof args["service"] === "string" ? args["service"] : "that service";
    const description = typeof args["description"] === "string" ? args["description"] : "the requested action";
    return (
      `Write/destructive actions on ${service} aren't available for that operation. ` +
      `I can't ${description} on ${service} from here. ` +
      `Continuing with the rest of your request if there's a buildable part.`
    );
  
};

