import { currentProjectFiles } from "../file-deletion.js";
import { deployToVercel, formatDeployForUser } from "../../deploy/vercel.js";
import { blockingSecurityFindings, runSecurityChecksSafely } from "../../verify/security.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const deployAppHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
      if (Object.keys(files).length === 0) {
        return "There is nothing to deploy yet — build the app first.";
      }
      if (!ctx.deploy) {
        // Not an error. The remedy is the user's and this is how they learn it.
        return (
          "This app is ready to deploy, but no Vercel account is connected yet. The user needs " +
          "to connect Vercel in their integrations settings (it takes a Vercel account token). " +
          "Tell them that and stop — do not try again."
        );
      }

      // The build-time result may be stale after follow-up edits. Re-scan the
      // exact file snapshot that is about to leave LampCode, independently of
      // the builder model, and fail closed when verification is unavailable.
      const securityScan = await runSecurityChecksSafely(
        ctx.projectId ?? "deployment",
        async () => new Map(Object.entries(files)),
      );
      if (!securityScan.ok) {
        return "Deployment blocked: security verification could not complete, so this app's security status is unknown. Nothing was sent to Vercel.";
      }
      const blockers = blockingSecurityFindings(securityScan.report.checks);
      if (blockers.length > 0) {
        return (
          "Deployment blocked by unresolved high/critical security findings:\\n" +
          blockers.map((finding) => `- [${finding.severity}] ${finding.message}`).join("\\n") +
          "\\nFix these findings and run deployment again. Nothing was sent to Vercel."
        );
      }

      const outcome = await deployToVercel({
        auth: {
          accessToken: ctx.deploy.vercelToken,
          ...(ctx.deploy.teamId === undefined ? {} : { teamId: ctx.deploy.teamId }),
        },
        files,
        projectName: ctx.deploy.projectName,
      });
      ctx.onLog?.(
        outcome.ok
          ? `Deployed: ${outcome.url ?? "(no url)"}`
          : `Deploy not successful: ${outcome.error ?? outcome.state ?? "unknown"}`,
      );
      // The user-facing lines, plus the one fact the MODEL needs that they do
      // not: whether it may describe this as done.
      return (
        `${formatDeployForUser(outcome).join("\n")}\n\n` +
        (outcome.ok
          ? "This deploy is verified — the URL was checked and answered. You may tell the user it is live."
          : "Do NOT describe this as deployed and working. Report exactly what is above.")
      );
    
};

