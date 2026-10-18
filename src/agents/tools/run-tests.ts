import { runTests } from "../../preview/e2b-service.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const runTestsHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      try {
        const run = await runTests(projectId);
        if (ctx.gateResults) {
          ctx.gateResults.writesAfterCheckTests = 0;
          ctx.gateResults.checkTests =
            run.outcome === "passed" ? "pass"
            : run.outcome === "failed" ? "fail"
            : run.outcome;
        }
        if (run.outcome === "unavailable") {
          return (
            `The tests could not be run: ${run.reason ?? "unknown reason"}. Nothing was ` +
            `verified — do not treat this as a pass. Carry on with the build and rely on ` +
            `check_page and check_types instead.`
          );
        }
        if (run.outcome === "none") {
          return (
            "There are no tests in this project yet, so nothing was verified. If this app " +
            "has logic whose correctness isn't obvious by reading it, write a test file " +
            "next to that code (e.g. src/lib/totals.test.ts), then call run_tests again."
          );
        }
        if (run.outcome === "passed") {
          return `All ${run.total} test(s) passed.`;
        }
        // Cap the detail: a broken shared module can fail fifty tests with the
        // same message, and fifty copies of it crowds out the context the model
        // needs to fix the one cause.
        const shown = run.failures.slice(0, 10);
        const omitted = run.failures.length - shown.length;
        return (
          `${run.failed} of ${run.total} test(s) failed.\n` +
          shown.map((f) => `- ${f.test}\n  ${f.message.replace(/\n/g, "\n  ")}`).join("\n") +
          (omitted > 0 ? `\n…and ${omitted} more failing test(s), likely the same cause.` : "") +
          `\nFix the code, not the test — unless the test itself asserts the wrong thing.`
        );
      } catch (err) {
        return `Error running the tests: ${err instanceof Error ? err.message : String(err)}`;
      }
    
};

