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

        // Keep the proven single-route check as diagnostic fallback, but it
        // cannot inspect visible first-run empty states or every declared page.
        // Therefore a clean legacy result is NOT a pass for the stronger page
        // contract; report it as unverified instead of hiding the missing sweep.
        const { ok, issues, unavailable } = await verifyBrowserRender(projectId);
        // Report "couldn't check" as itself. Saying the page rendered fine when
        // the browser never opened it is how an agent ships a blank app while
        // believing it verified one.
        if (unavailable) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "unavailable", ctx.gateResults.writesAfterCheckPage = 0;
          return "The page check could not run (the sandbox did not respond). Nothing was verified — do not treat this as a pass.";
        }
        if (ok || issues.length === 0) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "unavailable", ctx.gateResults.writesAfterCheckPage = 0;
          return (
            "The legacy single-route check saw no load error, but the full page-content sweep " +
            "could not run. Empty first-run states and other declared routes remain unverified; " +
            "do not treat this as a page-quality pass."
          );
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

