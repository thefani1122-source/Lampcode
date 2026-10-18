import { runTypeCheck } from "../../preview/e2b-service.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const checkTypesHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;
try {
      const { ok, issues, unavailable } = await runTypeCheck(projectId);
      if (unavailable) {
        if (ctx.gateResults) ctx.gateResults.checkTypes = "unavailable", ctx.gateResults.writesAfterCheckTypes = 0;
        return "The type check could not run (tsc was unreachable in the sandbox). Nothing was verified — do not treat this as a pass.";
      }
      if (ok || issues.length === 0) {
        if (ctx.gateResults) ctx.gateResults.checkTypes = "pass", ctx.gateResults.writesAfterCheckTypes = 0;
        return "No type errors.";
      }
      if (ctx.gateResults) ctx.gateResults.checkTypes = "fail", ctx.gateResults.writesAfterCheckTypes = 0;
      return `Type errors:\n${issues.map((i) => `- ${i.source}: ${i.message}`).join("\n")}`;
    } catch (err) {
      return `Error running the type check: ${err instanceof Error ? err.message : String(err)}`;
    }
};

