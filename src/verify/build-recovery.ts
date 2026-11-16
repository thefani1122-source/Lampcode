/**
 * A build can have a complete, editable source tree even when a verification
 * gate correctly marks its session failed. Such a tree must remain a repair
 * baseline; "failed" describes the verification outcome, not whether the
 * generated files should be discarded.
 */
export const RECOVERABLE_BUILD_STATUSES = ["success", "completed", "failed"] as const;

export type BuildFile = { path: string; code: string };

/**
 * Reconcile the current dispatch's files with the project's incrementally
 * persisted snapshot. A build can use multiple dispatches (or hit its turn
 * ceiling) while all successful writes have already reached Storage; the last
 * dispatch's in-memory map is therefore not necessarily the whole project.
 *
 * Current-dispatch writes win over Storage, and successful deletions are
 * applied last so a stale stored object cannot resurrect a removed file.
 * The private preview screenshot shares the bucket but is not project source.
 */
export function mergePersistedBuildFiles(
  currentFiles: readonly BuildFile[],
  persistedFiles: Record<string, string>,
  deletedPaths: readonly string[] = [],
): BuildFile[] {
  const isSafeProjectPath = (path: string): boolean => {
    if (
      !path ||
      path.startsWith("/") ||
      path.startsWith("\\\\") ||
      path.includes("\\0")
    ) return false;

    const segments = path.replace(/\\\\/g, "/").split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) return false;

    // Supabase stores the private preview thumbnail in the same bucket.
    return !segments[0]?.startsWith(".preview");
  };

  const merged = new Map<string, string>();
  for (const [path, code] of Object.entries(persistedFiles)) {
    if (isSafeProjectPath(path) && typeof code === "string") merged.set(path, code);
  }
  for (const file of currentFiles) {
    if (isSafeProjectPath(file.path) && typeof file.code === "string") {
      merged.set(file.path, file.code);
    }
  }
  for (const path of deletedPaths) merged.delete(path);

  return [...merged].map(([path, code]) => ({ path, code }));
}

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
