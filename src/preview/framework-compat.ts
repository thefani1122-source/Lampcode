import type { FullstackFramework } from "../agents/framework-selection.js"

/**
 * Projects created before framework metadata was stored always used the Vite
 * runtime. Treat a missing value as that legacy runtime, but never reuse an
 * unknown/stale runtime for a Next.js or TanStack request.
 */
export function canReuseSandboxForFramework(
  savedFramework: FullstackFramework | null,
  requestedFramework: FullstackFramework,
): boolean {
  if (savedFramework === null) return requestedFramework === "react"
  return savedFramework === requestedFramework
}
