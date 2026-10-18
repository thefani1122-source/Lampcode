import { verifyBrowserRender } from "../../preview/e2b-service.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { runPageSweep } from "./shared.js";
export const checkPageHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      try {
        // Every route the project declares, not just `/`. The old check opened
        // one URL, so every other page in a multi-page app was unobserved by
        // construction — which is the owner's standing complaint about pages
        // that do nothing, and it was true: nothing ever looked at them.
        const swept = await runPageSweep(ctx, projectId, "asked");
        if (swept !== null) return swept;

        // Fall back to the single-route check rather than reporting nothing.
        // That one is proven in production, so this change cannot leave the
        // model with less than it had; it only ever adds. A fallback that
        // reported "unavailable" on any hiccup in the new path would be a
        // regression dressed as a feature.
        const { ok, issues, unavailable } = await verifyBrowserRender(projectId);
        // Report "couldn't check" as itself. Saying the page rendered fine when
        // the browser never opened it is how an agent ships a blank app while
        // believing it verified one.
        if (unavailable) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "unavailable", ctx.gateResults.writesAfterCheckPage = 0;
          return "The page check could not run (the sandbox did not respond). Nothing was verified — do not treat this as a pass.";
        }
        if (ok || issues.length === 0) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "pass", ctx.gateResults.writesAfterCheckPage = 0;
          return "The page rendered successfully with no console errors.";
        }
        if (ctx.gateResults) ctx.gateResults.checkPage = "fail", ctx.gateResults.writesAfterCheckPage = 0;
        return (
          `The page has problems:\n${issues.map((i) => `- ${i.source}: ${i.message}`).join("\n")}\n` +
          `Call read_logs if you need the dev server's own account of what happened.`
        );
      } catch (err) {
        return `Error checking the page: ${err instanceof Error ? err.message : String(err)}`;
      }
    
};

