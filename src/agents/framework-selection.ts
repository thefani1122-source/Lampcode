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

/**
 * Which framework an EXISTING project already is, read from its own files.
 *
 * A new build takes its framework from the classifier; every follow-up edit
 * takes it from here, and the answer decides which contract the next prompt
 * carries — React/Vite serves its backend on a second origin and gets the
 * API_BASE rule, Next.js is same-origin and deliberately does not.
 *
 * Lives here rather than in the build route so its cases can run without
 * loading the server's graph, the same reason retry-policy.ts is its own file.
 */
export function detectFrameworkFromFiles(files: Record<string, string>): FullstackFramework {
  const paths = Object.keys(files);
  if ("app/routes/__root.tsx" in files) return "tanstack";

  // Next.js, by any of the shapes it legitimately takes. The old test was
  // `app/layout.tsx || next.config.js` and the second half was DEAD: the Ubuntu
  // template writes `next.config.ts` (e2b-template/template-nextjs-ubuntu.ts),
  // so a single missing app/layout.tsx was all it took to fall through to
  // "react" — and a follow-up edit would then hand a Next.js project the
  // Vite/Hono rules, including an API_BASE contract for an origin it does not
  // have. Several independent signals now, because misdetecting the framework
  // silently rewrites the contract the next edit is built on.
  if (paths.some((p) => /^next\.config\.(?:js|ts|mjs|cjs)$/.test(p))) return "nextjs";
  if (paths.some((p) => /^app\/(?:\([^/]+\)\/)*layout\.tsx$/.test(p))) return "nextjs";
  if (paths.some((p) => /^app\/(?:\([^/]+\)\/)*page\.tsx$/.test(p))) return "nextjs";
  if (paths.some((p) => /^app\/api\/.+\/route\.ts$/.test(p))) return "nextjs";

  const pkg = files["package.json"];
  if (pkg !== undefined && /"next"\s*:\s*"/.test(pkg)) return "nextjs";

  return "react";
}
