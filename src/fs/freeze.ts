import { join } from "path";
import { FreezeManager, type FreezeContract, type FileInput } from "../orchestrator/freeze-contract.js";
import { WorkspaceManager } from "./manager.js";
import { logger } from "../server/logger.js";

// ── Re-exports for convenience ────────────────────────────────────────────────

export type { FreezeContract, FileInput };

// ── Phase type (union mirrored from state-machine to avoid circular imports) ──

type FsPhase = "IDLE" | "PLANNING" | "FOUNDATION" | "BUILD" | "VERIFY" | "DEPLOY";

// ── WorkspaceFreezeManager ────────────────────────────────────────────────────

/**
 * Bridges the WorkspaceManager (live files) with FreezeManager (SHA-256
 * snapshots). Reads live files from the workspace, delegates hashing and
 * persistence to FreezeManager.
 */
export class WorkspaceFreezeManager {
  private readonly workspace: WorkspaceManager;
  private readonly freezer: FreezeManager;

  constructor(
    workspaceRoot?: string,
    freezeBaseDir?: string,
  ) {
    this.workspace = new WorkspaceManager(workspaceRoot);
    this.freezer = new FreezeManager(freezeBaseDir);
  }

  /**
   * Snapshot all files currently in the project workspace for a given phase.
   * Returns the immutable FreezeContract.
   */
  async freezePhase(
    projectId: string,
    sessionId: string,
    phase: FsPhase,
  ): Promise<FreezeContract> {
    const entries = await this.workspace.listFiles(projectId);

    const fileInputs: FileInput[] = await Promise.all(
      entries.map(async (entry) => ({
        path: entry.path,
        content: await this.workspace.readFile(projectId, entry.path),
      })),
    );

    const contract = await this.freezer.createFreeze(
      sessionId,
      phase as Parameters<FreezeManager["createFreeze"]>[1],
      fileInputs,
      [],
    );

    logger.info(
      { projectId, sessionId, phase, fileCount: fileInputs.length },
      "Phase frozen",
    );

    return contract;
  }

  /**
   * Re-read live workspace files and compare against the stored freeze.
   * Returns intact=true if no files have drifted.
   */
  async verifyFreeze(
    projectId: string,
    sessionId: string,
    phase: FsPhase,
  ): Promise<{ intact: boolean; drifted: string[] }> {
    const entries = await this.workspace.listFiles(projectId);

    const liveFiles: FileInput[] = await Promise.all(
      entries.map(async (entry) => ({
        path: entry.path,
        content: await this.workspace.readFile(projectId, entry.path),
      })),
    );

    const result = await this.freezer.verifyFreeze(
      sessionId,
      phase as Parameters<FreezeManager["verifyFreeze"]>[1],
      liveFiles,
    );

    logger.info(
      { projectId, sessionId, phase, intact: result.intact, drifted: result.drifted },
      "Freeze verification complete",
    );

    return result;
  }

  /**
   * Read and cryptographically verify the stored freeze contract for a phase.
   * Throws if the contract does not exist or has been tampered with.
   */
  async readFreeze(
    sessionId: string,
    phase: FsPhase,
  ): Promise<FreezeContract> {
    return this.freezer.readFreeze(
      sessionId,
      phase as Parameters<FreezeManager["readFreeze"]>[1],
    );
  }

  /** True if a freeze file exists for this session+phase. */
  async freezeExists(sessionId: string, phase: FsPhase): Promise<boolean> {
    return this.freezer.freezeExists(
      sessionId,
      phase as Parameters<FreezeManager["freezeExists"]>[1],
    );
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _freezeManager: WorkspaceFreezeManager | null = null;

export function getWorkspaceFreezeManager(
  workspaceRoot?: string,
  freezeBaseDir?: string,
): WorkspaceFreezeManager {
  if (_freezeManager === null) {
    _freezeManager = new WorkspaceFreezeManager(workspaceRoot, freezeBaseDir);
  }
  return _freezeManager;
}
