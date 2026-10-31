import { currentProjectFiles } from "../file-deletion.js";
import { deployToVercel, formatDeployForUser } from "../../deploy/vercel.js";
import { getBlockingSecurityFindings, runSecurityChecksSafely } from "../../verify/security.js";
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
      // Re-scan the exact in-memory snapshot that will be sent to Vercel.
      // Any previous build verdict is stale as soon as a file changes.
      const scanResult = await runSecurityChecksSafely(
        ctx.projectId,
        async () => new Map(Object.entries(files)),
      );
      if (!scanResult.ok) {
        const message =
          "Deployment blocked: security verification could not complete, so this version is NOT verified. " +
          "No files were sent to Vercel. Retry the security checks before deploying.";
        ctx.onLog?.(message);
        return message;
      }
      const blocking = getBlockingSecurityFindings(scanResult.report.checks);
      if (blocking.length > 0) {
        const details = blocking
          .map((check) => `- [${check.severity}] ${check.file ? check.file + ": " : ""}${check.message}`)
          .join("\n");
        const message =
          "Deployment blocked: critical/high security findings remain in the current files. " +
          "No files were sent to Vercel. Fix these findings and run the security checks again:\n" +
          details;
        ctx.onLog?.(message);
        return message;
      }
      const unverified = scanResult.report.checks.filter(
        (check) => check.status === "warn" && (check.severity === "critical" || check.severity === "high"),
      );

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
      const verificationNote = unverified.length > 0
        ? "\n\nSecurity checks NOT VERIFIED: " +
          unverified.map((check) => check.message).join("; ") +
          ". Do not describe this app as fully security-verified."
        : "";
      return (
        `${formatDeployForUser(outcome).join("\n")}\n\n` +
        (outcome.ok
          ? "This deploy is verified — the URL was checked and answered. You may tell the user it is live."
          : "Do NOT describe this as deployed and working. Report exactly what is above.") +
        verificationNote
      );
    
};

