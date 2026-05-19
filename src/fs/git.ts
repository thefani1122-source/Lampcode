import { simpleGit, type SimpleGit } from "simple-git";
import { join } from "path";
import { logger } from "../server/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = join(process.cwd(), "workspace");

// ── GitManager ────────────────────────────────────────────────────────────────

export class GitManager {
  private readonly git: SimpleGit;
  private readonly projectId: string;

  constructor(projectId: string, workspaceRoot: string = WORKSPACE_ROOT) {
    this.projectId = projectId;
    this.git = simpleGit(join(workspaceRoot, projectId));
  }

  /** Initialise git repo and create the initial empty commit. */
  async initRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (isRepo) {
      logger.debug({ projectId: this.projectId }, "Git repo already initialised");
      return;
    }
    await this.git.init();
    await this.git.raw(["commit", "--allow-empty", "-m", "init: workspace initialised"]);
    logger.info({ projectId: this.projectId }, "Git repo initialised");
  }

  /**
   * Create a new branch from HEAD, or switch to it if it already exists.
   * Returns the branch name.
   */
  async createBranch(name: string): Promise<string> {
    const branches = await this.git.branchLocal();
    if (branches.all.includes(name)) {
      await this.git.checkout(name);
      logger.debug({ projectId: this.projectId, branch: name }, "Switched to existing branch");
    } else {
      await this.git.checkoutLocalBranch(name);
      logger.info({ projectId: this.projectId, branch: name }, "Branch created");
    }
    return name;
  }

  /**
   * Merge `sourceBranch` into the currently checked-out branch.
   * Uses --no-ff to preserve merge topology.
   */
  async mergeBranch(sourceBranch: string, message: string): Promise<void> {
    await this.git.merge(["--no-ff", "-m", message, sourceBranch]);
    logger.info({ projectId: this.projectId, sourceBranch, message }, "Branch merged");
  }

  /** Stage all changes and create a commit. */
  async commitAll(message: string): Promise<string> {
    await this.git.add(".");
    const result = await this.git.commit(message);
    const sha = result.commit;
    logger.info({ projectId: this.projectId, sha, message }, "Committed all changes");
    return sha;
  }

  /** Return the SHA of HEAD on the current branch. */
  async headSha(): Promise<string> {
    const log = await this.git.log({ maxCount: 1 });
    const latest = log.latest;
    if (!latest) throw new Error(`No commits in repo for project ${this.projectId}`);
    return latest.hash;
  }

  /** Return the name of the currently checked-out branch. */
  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "HEAD";
  }

  /** List all local branches. */
  async listBranches(): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createGitManager(
  projectId: string,
  workspaceRoot?: string,
): GitManager {
  return new GitManager(projectId, workspaceRoot);
}
