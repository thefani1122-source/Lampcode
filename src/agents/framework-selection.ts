export type FullstackFramework = "react" | "nextjs" | "tanstack";

export const DEFAULT_BUILD_FRAMEWORK: FullstackFramework = "nextjs";

/**
 * Read only the server-appended framework marker. User prompt vocabulary is
 * never inspected to choose a framework. The marker is appended after the
 * original request by the build route, so the final occurrence is authoritative.
 */
export function selectedBuildFramework(description: string): FullstackFramework | null {
  const marker = "LAMPCode_SELECTED_FRAMEWORK:";
  let selected: string | null = null;

  for (const line of description.split(/\r?\n/)) {
    const at = line.lastIndexOf(marker);
    if (at < 0) continue;
    selected = line.slice(at + marker.length).trim().toLowerCase().split(/\s+/)[0] ?? null;
  }

  if (selected === "react" || selected === "nextjs" || selected === "tanstack") {
    return selected;
  }
  return null;
}

/**
 * Compatibility helper for prompt composition. It does not classify prompts:
 * it reads trusted build metadata, or returns LampCode's static Next.js default.
 */
export function detectFullstackFramework(description: string): FullstackFramework {
  return selectedBuildFramework(description) ?? DEFAULT_BUILD_FRAMEWORK;
}
