export type FullstackFramework = "react" | "nextjs" | "tanstack"

const NEXT_REQUEST = /\bnext\.?\s*js\b|\bnextjs\b/i
const TANSTACK_REQUEST = /\btanstack(?:[- ]?start)?\b|\btss\b/i
const EXPLICIT_VITE_OR_SEPARATE_API =
  /\bvite\b|\bhono\b|\bexpress\b|\bfastapi\b|\bdjango\b|\bpython\s+(?:backend|api|server)\b|\breact\s*(?:\+|and)\s*(?:hono|express)\b/i

/**
 * Select the framework only for full-stack builds. Next becomes the default
 * once the current Ubuntu candidate is explicitly configured; explicit Next
 * requests still choose Next so a missing/stale image fails visibly rather
 * than silently generating a Vite app with a Next.js prompt.
 */
export function detectFullstackFramework(prompt: string): FullstackFramework {
  if (TANSTACK_REQUEST.test(prompt)) return "tanstack"
  if (NEXT_REQUEST.test(prompt)) return "nextjs"
  if (EXPLICIT_VITE_OR_SEPARATE_API.test(prompt)) return "react"
  const configuredNext = process.env["NEXTJS_TEMPLATE_ID"] ?? ""
  if (/^lampcode-nextjs-ubuntu24(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(configuredNext)) return "nextjs"
  return "react"
}
