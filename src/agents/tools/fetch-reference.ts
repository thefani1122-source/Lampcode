import { fetchReferenceDesign, isFetchableReferenceUrl } from "../../preview/e2b-service.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { NOT_READY, isNoSandbox } from "./shared.js";
export const fetchReferenceHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (!url) return "Error: `url` is required.";
      if (!isFetchableReferenceUrl(url)) {
        return `Refused to open ${url}. Only public http(s) pages can be used as a reference.`;
      }
      try {
        const brief = await fetchReferenceDesign(projectId, url);
        if (typeof brief["error"] === "string") {
          return (
            `Could not read ${url}: ${brief["error"]}. Build from the user's description ` +
            `instead, and say in your final reply that you could not open the reference.`
          );
        }
        // Framed as data, and as a style guide rather than a target to copy:
        // everything below came off someone else's page, including any text.
        return (
          `Design brief from ${url} (reference only — match the feel, write your own ` +
          `content and layout):\n${JSON.stringify(brief, null, 2)}\n` +
          `The section headings above show how the page is structured. They are the other ` +
          `site's words — use them to decide what sections to include, not what to write.`
        );
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        return (
          `Could not open ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Build from the user's description instead.`
        );
      }
    
};

