import { z } from "zod";

export const REQUEST_PROJECT_BUILD_TOOL_NAME = "request_project_build" as const;

const requestProjectBuildSchema = z.object({
  reason: z.string().trim().min(1).max(600),
});

export type ProjectBuildHandoff =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/**
 * Validate a model-requested transition from conversational/read-only mode
 * into the project workspace pipeline. This signal does not itself write files
 * or call external services; the host decides whether to start the build path.
 */
export function parseProjectBuildHandoff(argumentsJson: string): ProjectBuildHandoff {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson || "{}");
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }

  const parsed = requestProjectBuildSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Provide a short reason explaining why the original request requires project workspace execution.",
    };
  }

  return { ok: true, reason: parsed.data.reason };
}
