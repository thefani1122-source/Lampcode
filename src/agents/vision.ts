import { config } from "../server/config.js";
import { logger } from "../server/logger.js";

/**
 * Whether the model serving this build can look at an image (F2).
 *
 * MEASURED 2026-10-18 against the live gateway, with the same request twice:
 *
 *   with an image part   → HTTP 400 {"error":{"code":"validation_error",
 *                          "message":"Model does not support image modality"}}
 *   without it           → HTTP 200
 *
 * So on `minimax.minimax-m2.5` — the model every build currently uses — a
 * screenshot does not degrade to "the model ignored it". It fails the whole
 * request, which would turn a verification aid into a broken build. That is why
 * this module exists and why it defaults to NO.
 *
 * There is no model-capability list here on purpose. A hardcoded list of which
 * models have vision is a guess that ages badly and silently; this instead
 * takes three honest sources, in order:
 *
 *   1. `LLM_SUPPORTS_IMAGES`, when the owner has set it either way.
 *   2. What the provider has already told us this process — a 400 naming the
 *      image modality is remembered and never retried.
 *   3. Otherwise: no. An unprobed model is treated as text-only, because the
 *      cost of being wrong is a failed request rather than a missing nicety.
 *
 * `noteImageRejection` is what turns a provider's refusal into (2), so one
 * failed attempt per process is the worst case rather than one per build.
 */

/** Set once a provider has refused an image for this model. */
const rejected = new Set<string>();

function modelKey(): string {
  return config.LLM_MODEL_NAME ?? config.MODAL_MODEL_NAME ?? "unknown";
}

/** True only when a screenshot may safely be put in front of the model. */
export function visionSupported(): boolean {
  if (config.LLM_SUPPORTS_IMAGES === false) return false;
  if (rejected.has(modelKey())) return false;
  return config.LLM_SUPPORTS_IMAGES === true;
}

/** Why vision is off, in the words a tool can hand back to the model. */
export function visionUnavailableReason(): string {
  if (rejected.has(modelKey())) {
    return "the model serving this build refused an image earlier in this process";
  }
  if (config.LLM_SUPPORTS_IMAGES === false) {
    return "image input is switched off for this deployment";
  }
  return "the model serving this build is not known to accept images";
}

/**
 * Remember that the provider rejected an image, so nothing tries again.
 *
 * Called from the gateway when a request carrying an image comes back with an
 * error naming the image modality. Deliberately narrow: a generic 400 is not
 * evidence about vision, and treating one as such would switch off a working
 * capability on the first unrelated validation error.
 */
export function noteImageRejection(message: string): boolean {
  if (!/image|modality|vision|multimodal/i.test(message)) return false;
  const key = modelKey();
  if (rejected.has(key)) return true;
  rejected.add(key);
  logger.warn(
    { model: key, message: message.slice(0, 200) },
    "[vision] the provider refused an image for this model — no screenshot will be sent to it again this process",
  );
  return true;
}

/** Test seam. Not called in production code. */
export function resetVisionMemory(): void {
  rejected.clear();
}
