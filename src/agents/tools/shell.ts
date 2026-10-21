import { randomUUID } from "node:crypto";
import { runShellCommand } from "../../preview/e2b-service.js";
import { classifyShellCommand, redactShellOutput } from "../../verify/shell-policy.js";
import { createPendingApproval, resolveApproval, APPROVAL_TIMEOUT_MS } from "../pending-approvals.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../../server/logger.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Run a command in the sandbox.
 *
 * The policy is in `src/verify/shell-policy.ts` and it is the real work; this
 * is the plumbing between it, the approval gate the MCP write proxies already
 * use, and the executor. Three things happen here and nowhere else:
 *
 *  - a REFUSED command never reaches the sandbox, and the model is told why in
 *    a sentence it can act on, naming the tool that does the job properly;
 *  - an APPROVAL-tier command waits for the user, exactly as a write to their
 *    GitHub does, and a timeout is a denial;
 *  - everything that comes back is REDACTED before it becomes a tool result —
 *    including the output of commands that looked harmless, because the output
 *    of `npm run build` can carry a connection string in an error message.
 */
export const shellHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => {
  const projectId = ctx.projectId;
  if (!projectId) return "Error: no project sandbox is attached to this build.";

  const command = typeof args["command"] === "string" ? args["command"].trim() : "";
  if (!command) return "Error: `command` is required.";

  const verdict = classifyShellCommand(command);

  if (verdict.tier === "refused") {
    // Logged with the command, because a refusal is the single most useful
    // line in a build's log when someone asks later what the agent tried.
    logger.warn({ sessionId: ctx.sessionId, projectId, command: command.slice(0, 200) }, "[shell] refused");
    return `Refused: ${verdict.reason}`;
  }

  if (verdict.tier === "approval") {
    const sessionId = ctx.sessionId ?? "";
    const toolCallId = ctx.toolCallId ?? randomUUID();

    // Same fail-all rule as the MCP write proxies: once the user has denied
    // something this turn, the rest of the turn is denied without asking
    // again. Half of a sequence of changes is worse than none of it.
    if (ctx.writeDenied?.value) return "Cancelled: a previous action was denied this turn.";

    const pending = createPendingApproval(toolCallId, sessionId);
    let asked = false;
    try {
      getWebSocketServer().emitToRoom(sessionId, "build:write_action_approval_required", {
        toolCallId,
        serverSlug: "sandbox",
        toolName: "shell",
        toolInput: { command },
        timeoutMs: APPROVAL_TIMEOUT_MS,
        tier: "approval",
        tierNote: `Runs a command in this project's sandbox: ${verdict.reason}.`,
        sessionId,
      });
      asked = true;
    } catch {
      // Nobody is listening, so nobody can answer. Deny.
      resolveApproval(toolCallId, sessionId, false);
    }

    let approved = false;
    if (asked) {
      approved = await Promise.race([
        pending,
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            resolveApproval(toolCallId, sessionId, false);
            resolve(false);
          }, APPROVAL_TIMEOUT_MS),
        ),
      ]);
    }

    if (!approved) {
      if (ctx.writeDenied) ctx.writeDenied.value = true;
      try {
        getWebSocketServer().emitToRoom(sessionId, "build:write_action_denied", {
          toolCallId, toolName: "shell", serverSlug: "sandbox", sessionId,
        });
      } catch { /* ws unavailable */ }
      return "Denied: the user did not approve that command. Carry on without it, or do the same thing with a tool that does not need approval.";
    }
  }

  const result = await runShellCommand(projectId, command);
  if (!result.ran) {
    return "The sandbox is not available, so nothing was run. check_types, run_tests and read_logs work without one.";
  }

  // Redacted even on the quiet path. `npm run build` can print a connection
  // string in a stack trace, and a tool result goes to the model, the chat and
  // build_messages at once — there is no taking it back afterwards.
  const out = redactShellOutput(
    [result.stdout, result.stderr].filter((part) => part.trim()).join("\n"),
    result.secrets,
  );
  if (out.redacted > 0) {
    logger.info(
      { sessionId: ctx.sessionId, projectId, redacted: out.redacted },
      "[shell] secrets removed from command output",
    );
  }

  const status = result.exitCode === 0 ? "exit 0" : `exit ${result.exitCode}`;
  const body = out.text.trim() || "(no output)";
  const note = out.redacted > 0
    ? `\n\n${out.redacted} secret value(s) were removed from this output. They are in the sandbox's .env; you do not need them and must not try to read them.`
    : "";
  return `$ ${command}\n${status}\n\n${body}${note}`;
};
