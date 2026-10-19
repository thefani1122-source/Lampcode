import { capturePreviewScreenshot } from "../../preview/e2b-service.js";
import { visionSupported, visionUnavailableReason } from "../vision.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Let the model LOOK at the page it built (F2).
 *
 * `check_page` reads the DOM: it answers "did it render, were there console
 * errors, is the root empty". It cannot see that the header sits on top of the
 * hero, that white text landed on a white card, or that a layout collapsed at
 * the width the user asked for. Those are the complaints a person makes first,
 * and until now nothing in the loop could observe them.
 *
 * `capturePreviewScreenshot` already existed and was used for ONE thing: the
 * thumbnail on the project card. The picture was taken and never shown to the
 * model. This hands it over.
 *
 * It refuses honestly when the model cannot see. Measured 2026-10-18: the live
 * model answers HTTP 400 "Model does not support image modality", so sending
 * one anyway would fail the request — a failed build in place of a screenshot.
 * The refusal says so and points at the check that does work.
 */
export const lookAtPageHandler: ToolHandler = async (
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => {
  const projectId = ctx.projectId;
  if (!projectId) return "Error: no project sandbox is attached to this build.";

  if (!visionSupported()) {
    return (
      `Cannot look at the page: ${visionUnavailableReason()}. ` +
      `Use check_page instead — it reads the rendered DOM and the console, which catches a blank ` +
      `page, a crash and an unresolved import. Do not call this again in this build.`
    );
  }

  const shot = await capturePreviewScreenshot(projectId).catch(() => null);
  if (!shot) {
    return (
      "Could not take a screenshot — the preview may not be serving yet. " +
      "check_page reports on the same page without needing one."
    );
  }

  // Handed to the dispatcher rather than returned: a tool result is a string,
  // and an image has to travel as its own content block in the next turn.
  ctx.pendingImages?.value.push({
    mediaType: "image/png",
    dataBase64: shot.toString("base64"),
    label: "the app's home page, as it renders right now (1280x800)",
  });

  return (
    "Screenshot taken — it is attached to the next message. Look at the layout, the contrast and " +
    "whether anything overlaps or is cut off, then fix what you see. Do not describe the image back to me."
  );
};
