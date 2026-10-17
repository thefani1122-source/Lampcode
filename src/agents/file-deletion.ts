/** Pure file-map decisions for delete_file; sandbox and storage effects stay in the handler. */
export const PROTECTED_ENTRY_POINTS = new Set([
  "src/App.tsx",
  "app/page.tsx",
  "app/routes/index.tsx",
]);

export type FileDeletionDecision = {
  path: string;
  status: "ready" | "missing" | "template-owned" | "entry-point" | "unsafe-path";
  before?: string;
};

/** Merge current edits over the build-start snapshot, then apply tombstones. */
export function currentProjectFiles(
  projectFiles: Record<string, string> | undefined,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: ReadonlySet<string> | undefined,
): Record<string, string> {
  const files = { ...(projectFiles ?? {}), ...(generatedFiles ?? {}) };
  for (const path of deletedFiles ?? []) delete files[path];
  return files;
}

/** Resolve one path from the current project, never from its build-start snapshot after deletion. */
export function currentProjectFile(
  path: string,
  projectFiles: Record<string, string> | undefined,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: ReadonlySet<string> | undefined,
): string | undefined {
  if (deletedFiles?.has(path)) return undefined;
  return currentProjectFiles(projectFiles, generatedFiles, deletedFiles)[path];
}

/** Apply an explicit write and clear its tombstone; edit_file must never call this. */
export function recordProjectFileWrite(
  path: string,
  content: string,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: Set<string> | undefined,
): void {
  if (deletedFiles) deletedFiles.delete(path);
  if (generatedFiles) generatedFiles[path] = content;
}

export function deletedFileEditMessage(path: string): string {
  return `${path} is deleted from the current project. Use write_files if you intentionally want to recreate it.`;
}

/** Classify a batch before side effects so every refusal can be reported by path. */
export function planFileDeletions(
  paths: string[],
  files: Record<string, string>,
  isTemplateOwned: (path: string) => boolean,
): FileDeletionDecision[] {
  const seen = new Set<string>();
  const decisions: FileDeletionDecision[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);

    // Match the sandbox writer's traversal guard before constructing an E2B path.
    if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("..") || path.includes("\0")) {
      decisions.push({ path, status: "unsafe-path" });
    } else if (isTemplateOwned(path)) {
      decisions.push({ path, status: "template-owned" });
    } else if (PROTECTED_ENTRY_POINTS.has(path.replace(/\\/g, "/"))) {
      decisions.push({ path, status: "entry-point" });
    } else if (files[path] === undefined) {
      decisions.push({ path, status: "missing" });
    } else {
      decisions.push({ path, status: "ready", before: files[path] });
    }
  }
  return decisions;
}

/** Preserve projectFiles as the immutable build-start baseline. */
export function markFileDeleted(
  path: string,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: Set<string>,
): void {
  if (generatedFiles) delete generatedFiles[path];
  deletedFiles.add(path);
}

/** Commit in-memory state and its measurements only after both deletes succeed. */
export function commitFileDeletion(
  path: string,
  before: string,
  generatedFiles: Record<string, string> | undefined,
  deletedFiles: Set<string>,
  recordChurn: (before: string, after: "", kind: "deleted") => void,
  recordWrite: () => void,
): void {
  markFileDeleted(path, generatedFiles, deletedFiles);
  recordChurn(before, "", "deleted");
  recordWrite();
}

