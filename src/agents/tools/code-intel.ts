import { currentProjectFiles } from "../file-deletion.js";
import { codeIntel, formatCodeIntel } from "../../verify/code-intel.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Ask what a symbol IS and who uses it, instead of re-reading files to guess.
 *
 * `search_code` finds text. This resolves meaning: one definition, the real
 * references, and the exported surface of a file. On a forty-file app the
 * difference is whether renaming a field is a three-second lookup or six more
 * file reads that each cost a round.
 */
export const codeIntelHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => {
  const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
  if (Object.keys(files).length === 0) {
    return "There are no project files yet. Ask about a symbol once code has been written.";
  }

  const symbol = typeof args["symbol"] === "string" ? args["symbol"].trim() : "";
  const path = typeof args["path"] === "string" ? args["path"].trim() : "";
  if (!symbol && !path) {
    return "Give either a symbol (what is it, who calls it) or a path (what does this file export).";
  }

  return formatCodeIntel(
    codeIntel(files, {
      ...(symbol ? { symbol } : {}),
      ...(path ? { path } : {}),
    }),
  );
};
