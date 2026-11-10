/**
 * A build can have a complete, editable source tree even when a verification
 * gate correctly marks its session failed. Such a tree must remain a repair
 * baseline; "failed" describes the verification outcome, not whether the
 * generated files should be discarded.
 */
export const RECOVERABLE_BUILD_STATUSES = ["success", "completed", "failed"] as const;

/** Keep only sessions that actually have a source directory attached. */
export function isRecoverableBuildSession(
  status: string,
  outputDir: string | null | undefined,
): boolean {
  return outputDir != null && outputDir.trim().length > 0 &&
    (RECOVERABLE_BUILD_STATUSES as readonly string[]).includes(status);
}

/**
 * A storage snapshot from an interrupted first build is a useful recovery
 * source only when its framework entrypoint exists. Never turn a few security
 * helper files into an "existing application" and skip the new-build checks.
 */
export function hasRecoverableAppEntrypoint(files: Record<string, string>): boolean {
  return [
    "src/App.tsx",
    "app/page.tsx",
    "app/routes/index.tsx",
  ].some((path) => typeof files[path] === "string" && files[path]!.trim().length > 0);
}
