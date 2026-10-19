/**
 * Cases for F2 — letting the model LOOK at the page. Run by `npm test`.
 *
 * THE MEASUREMENT THIS IS BUILT ON, taken 2026-10-18 against the live gateway,
 * the same request twice:
 *
 *   with an image part   → HTTP 400 {"error":{"code":"validation_error",
 *                          "message":"Model does not support image modality"}}
 *   without it           → HTTP 200
 *
 * So on `minimax.minimax-m2.5`, which every build currently uses, a screenshot
 * does not degrade to "the model ignored the picture". It fails the request
 * outright — a broken build in place of a verification aid.
 *
 * That is why the default is NO and why these cases are mostly about the
 * refusal. The path itself is real and translated for both providers; what must
 * never happen is a screenshot being sent to a model that cannot see it, or
 * this code claiming a capability nobody measured.
 */

import { readFileSync } from "node:fs";
import { noteImageRejection, resetVisionMemory, visionSupported, visionUnavailableReason } from "../src/agents/vision.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

// ── Default: an unprobed model is treated as text-only ─────────────────────

resetVisionMemory();
check("vision is off unless it was configured on", !visionSupported());
check("and the reason says so rather than claiming a failure", visionUnavailableReason().includes("not known to accept images"));

// ── A provider refusal is remembered, so one request pays for it ───────────

check(
  "the measured 400 is recognised",
  noteImageRejection('{"error":{"code":"validation_error","message":"Model does not support image modality"}}'),
);
check("after that, the reason names the refusal", visionUnavailableReason().includes("refused an image"));
check("and vision stays off", !visionSupported());

resetVisionMemory();
check("an unrelated validation error is NOT read as a vision verdict", !noteImageRejection("maximum context length exceeded"));
check("a 429 is not either", !noteImageRejection("rate limit exceeded, retry after 60s"));
check("nor an auth failure", !noteImageRejection("invalid api key"));
check("so vision is not switched off by an unrelated error", visionUnavailableReason().includes("not known to accept images"));

// ── The request shape, on both providers ──────────────────────────────────

{
  const gateway = readFileSync(new URL("../src/agents/model-gateway.ts", import.meta.url), "utf8");
  check("an image block exists in the message union", gateway.includes("export interface ImageContentBlock"));
  check("declared in the Anthropic shape it is sent as", gateway.includes('type: "base64"; media_type: string; data: string'));
  check("with the measurement recorded beside it", gateway.includes("answers 200 to the"));

  const modal = readFileSync(new URL("../src/agents/modal-gateway.ts", import.meta.url), "utf8");
  check("the OpenAI path translates it to image_url", modal.includes('type: "image_url"'));
  check("as a data URI", modal.includes("`data:${b.source.media_type};base64,${b.source.data}`"));
  check(
    "an image is no longer silently dropped on that path",
    modal.includes('} else if (b.type === "image") {'),
  );
  check("the text that came with the image travels with it", modal.includes("...(textParts.length > 0 ? [{ type: \"text\", text: textParts.join(\"\") }] : [])"));
  check("a refusal is only remembered when the request actually carried an image", modal.includes("body.messages?.some?.(hasImagePart)"));
  check("and only on a 400", modal.includes("response.status === 400 && body.messages"));
}

// ── The tool refuses honestly, and never sends into a text-only model ─────

{
  const tool = readFileSync(new URL("../src/agents/tools/look-at-page.ts", import.meta.url), "utf8");
  check("look_at_page checks support before taking a screenshot", tool.indexOf("visionSupported()") < tool.indexOf("capturePreviewScreenshot(projectId)"));
  check("its refusal says why", tool.includes("visionUnavailableReason()"));
  check("and points at the check that does work", tool.includes("Use check_page instead"));
  check("and tells the model not to retry", tool.includes("Do not call this again in this build"));
  check("it reuses the existing screenshot capture rather than a second one", tool.includes("capturePreviewScreenshot"));
  check("a failed screenshot is not an error either", tool.includes("Could not take a screenshot"));

  const defs = readFileSync(new URL("../src/agents/tools.ts", import.meta.url), "utf8");
  check("the tool is offered to agentic builds", defs.indexOf('name: "look_at_page"') > defs.indexOf("export const AGENTIC_BUILD_TOOLS"));
  check("its description says what check_page cannot see", defs.includes("can never see that the"));
  check("and warns it is not free", defs.includes("Expensive in tokens"));
  check("it requires a sandbox", defs.includes('"check_types", "look_at_page"'));

  const registry = readFileSync(new URL("../src/agents/tools/registry.ts", import.meta.url), "utf8");
  check("the registry can execute it", registry.includes('["look_at_page", lookAtPageHandler]'));

  const dispatcher = readFileSync(new URL("../src/agents/dispatcher.ts", import.meta.url), "utf8");
  check("the dispatcher carries the screenshot into the next turn", dispatcher.includes("pendingImages"));
  check("and checks support again before it does", dispatcher.includes("if (visionSupported()) {"));
  check("the queue is cleared either way, so an unsent shot cannot pile up", dispatcher.includes("pendingImages.value.length = 0;"));
}

console.log(`\n${checks} vision checks passed`);
