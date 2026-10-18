import { createPendingAnswer, resolveAnswer, ANSWER_TIMEOUT_MS } from "../pending-answers.js";
import { getWebSocketServer } from "../../websocket/server.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
export const askUserHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
    const question = typeof args["question"] === "string" ? args["question"].trim() : "";
    if (!question) return "Error: ask_user needs a question.";
    const sessionId = ctx.sessionId;
    const toolCallId = ctx.toolCallId;
    // Same precondition as the write proxies: with no session to ask through,
    // there is nobody to answer, and inventing one would defeat the tool.
    if (!sessionId || !toolCallId) {
      return "Could not ask: no live session. Decide it yourself and say which assumption you made.";
    }

    const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        label: String(o["label"] ?? ""),
        description: typeof o["description"] === "string" ? o["description"] : "",
        recommended: o["recommended"] === true,
      }))
      .filter((o) => o.label.length > 0)
      .slice(0, 4);

    const pending = createPendingAnswer(toolCallId, sessionId);
    try {
      getWebSocketServer().emitToRoom(sessionId, "build:question_asked", {
        toolCallId,
        question,
        options,
        timeoutMs: ANSWER_TIMEOUT_MS,
        sessionId,
      });
    } catch {
      // No websocket means the prompt never reaches anyone. Resolve the entry
      // rather than leaving it in the Map, and tell the model to proceed.
      resolveAnswer(toolCallId, sessionId, "");
      return "Could not ask: no live session. Decide it yourself and say which assumption you made.";
    }

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => {
        resolveAnswer(toolCallId, sessionId, "");
        resolve(null);
      }, ANSWER_TIMEOUT_MS),
    );
    const answer = await Promise.race([pending, timeout]);

    if (answer === null || answer === "") {
      return (
        "No answer — the person did not reply in time. Do NOT ask again. Pick the most " +
        "reasonable option yourself, build it, and state in your summary which assumption you made."
      );
    }
    return `The person answered: ${answer}`;
  
};

