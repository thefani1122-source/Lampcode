import { readSandboxLogs } from "../../preview/e2b-service.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { NOT_READY } from "./shared.js";
export const readLogsHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      const logs = readSandboxLogs(projectId);
      if (!logs) return NOT_READY;
      const parts: string[] = [];
      if (logs.dev.length > 0) parts.push(`Dev server output:\n${logs.dev.join("\n")}`);
      if (logs.backend.length > 0) parts.push(`Backend output:\n${logs.backend.join("\n")}`);
      if (parts.length === 0) {
        return "Nothing has been logged yet — the servers may still be starting.";
      }
      return parts.join("\n\n");
    
};

