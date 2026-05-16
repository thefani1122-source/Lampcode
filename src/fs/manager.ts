import { simpleGit, CheckRepoActions, type SimpleGit, type StatusResult, type DiffResult } from "simple-git";
import { join, dirname, normalize } from "path";
import { logger } from "../server/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = join(process.cwd(), "workspace");

// Branch naming: bf/<agentType>/<sessionId> keeps per-session branches isolated
const branchName = (agentType: string, sessionId: string) =>
  `bf/${agentType}/${sessionId}`;

// ── Result types ──────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
}

export interface BranchDiff {
  files: FileDiff[];
  totalInsertions: number;
  totalDeletions: number;
  summary: string;
}

// ── WorkspaceManager ──────────────────────────────────────────────────────────

export class WorkspaceManager {
  private readonly root: string;

  constructor(workspaceRoot: string = WORKSPACE_ROOT) {
    this.root = workspaceRoot;
  }

  // ── Workspace lifecycle ────────────────────────────────────────────────────

  /**
   * Create /workspace/:projectId/ and initialise a bare git repo inside it.
   * Safe to call if the workspace already exists.
   */
  async createWorkspace(projectId: string): Promise<string> {
    const dir = this.projectDir(projectId);
    const { mkdir } = await import("fs/promises");
    await mkdir(dir, { recursive: true });

    const git = simpleGit(dir);
    const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT).catch(() => false);
    if (!isRepo) {
      await git.init();
      // Create an initial empty commit so branches can be created immediately
      await git.raw(["commit", "--allow-empty", "-m", "init: workspace initialised"]);
      logger.info({ projectId, dir }, "Workspace initialised");
    } else {
      logger.debug({ projectId }, "Workspace already exists");
    }

    return dir;
  }

  /**
   * Create an isolated git branch for a specific agent within a session.
   * The branch is forked from the current HEAD so it carries all previous
   * committed work.
   */
  async createAgentBranch(
    projectId: string,
    agentType: string,
    sessionId: string,
  ): Promise<string> {
    const git = this.git(projectId);
    const branch = branchName(agentType, sessionId);

    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      await git.checkout(branch);
      logger.debug({ projectId, branch }, "Switched to existing agent branch");
    } else {
      await git.checkoutLocalBranch(branch);
      logger.info({ projectId, branch }, "Agent branch created");
    }

    return branch;
  }

  // ── File operations ────────────────────────────────────────────────────────

  /**
   * Atomically write a file on the current branch.
   * Creates parent directories as needed. The write is not automatically
   * committed — call git.commit() when a logical unit of work is complete.
   */
  async writeFile(
    projectId: string,
    filePath: string,
    content: string,
  ): Promise<string> {
    const { writeFile, mkdir } = await import("fs/promises");
    const safe = this.safePath(filePath);
    const full = join(this.projectDir(projectId), safe);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    logger.debug({ projectId, path: safe, bytes: Buffer.byteLength(content) }, "File written");
    return safe;
  }

  /** Read a file from the project workspace on the current branch. */
  async readFile(projectId: string, filePath: string): Promise<string> {
    const { readFile } = await import("fs/promises");
    const safe = this.safePath(filePath);
    const full = join(this.projectDir(projectId), safe);
    return readFile(full, "utf8");
  }

  /**
   * List all tracked and untracked files under the project workspace.
   * Returns paths relative to the project root.
   */
  async listFiles(projectId: string): Promise<FileEntry[]> {
    const { stat, readdir } = await import("fs/promises");
    const dir = this.projectDir(projectId);

    const walk = async (base: string, current: string): Promise<FileEntry[]> => {
      const entries: FileEntry[] = [];
      let items: string[];
      try {
        items = await readdir(current);
      } catch {
        return entries;
      }
      for (const item of items) {
        if (item === ".git") continue;
        const full = join(current, item);
        let s;
        try { s = await stat(full); } catch { continue; }
        if (s.isDirectory()) {
          entries.push(...await walk(base, full));
        } else {
          entries.push({
            path: full.slice(base.length + 1),
            sizeBytes: s.size,
            modifiedAt: s.mtime.toISOString(),
          });
        }
      }
      return entries;
    };

    return walk(dir, dir);
  }

  // ── Branch diffing ─────────────────────────────────────────────────────────

  /**
   * Return a structured diff between two branches (or refs).
   * Uses `git diff --stat` + `git diff --numstat` for precise line counts.
   */
  async diffBranches(
    projectId: string,
    branchA: string,
    branchB: string,
  ): Promise<BranchDiff> {
    const git = this.git(projectId);

    // --numstat gives machine-readable insertions/deletions per file
    const numstat = await git.raw(["diff", "--numstat", branchA, branchB]);
    const files: FileDiff[] = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (const line of numstat.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [ins, del, path] = parts;
      if (!path) continue;
      const insertions = ins === "-" ? 0 : parseInt(ins ?? "0", 10);
      const deletions  = del === "-" ? 0 : parseInt(del ?? "0", 10);
      totalInsertions += insertions;
      totalDeletions  += deletions;
      files.push({ path, status: "modified", insertions, deletions });
    }

    // Enrich with rename/add/delete status via --diff-filter
    const nameStatus = await git.raw(["diff", "--name-status", branchA, branchB]);
    for (const line of nameStatus.trim().split("\n")) {
      if (!line.trim()) continue;
      const [rawStatus, ...pathParts] = line.split("\t");
      const filePath = pathParts[0];
      if (!filePath || !rawStatus) continue;
      const entry = files.find((f) => f.path === filePath);
      const status = rawStatus.startsWith("R") ? "renamed"
        : rawStatus === "A" ? "added"
        : rawStatus === "D" ? "deleted"
        : "modified";
      if (entry) {
        entry.status = status;
      } else {
        files.push({ path: filePath, status, insertions: 0, deletions: 0 });
      }
    }

    const summary = `${files.length} file(s) changed, ${totalInsertions} insertion(s)(+), ${totalDeletions} deletion(s)(-)`;
    return { files, totalInsertions, totalDeletions, summary };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  projectDir(projectId: string): string {
    return join(this.root, projectId);
  }

  git(projectId: string): SimpleGit {
    return simpleGit(this.projectDir(projectId));
  }

  /** Strip leading slashes and prevent directory traversal. */
  private safePath(filePath: string): string {
    return normalize(filePath)
      .replace(/^[\\/]+/, "")
      .replace(/\.\.\//g, "")
      .replace(/^\.\./, "");
  }
}
