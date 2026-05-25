import { and, desc, eq, max } from "drizzle-orm";
import { db } from "../db/client.js";
import { sharedBrainFiles, type BrainFileType, type SharedBrainFile } from "../db/schema.js";
import { logger } from "../server/logger.js";
import { lcsLineDiff, type DiffLine } from "./diff.js";

// ── Re-export for convenience ─────────────────────────────────────────────────

export type { DiffLine };

export interface VersionCompare {
  fileType: BrainFileType;
  fromVersion: number;
  toVersion: number;
  diff: DiffLine[];
  insertions: number;
  deletions: number;
}

// ── BrainManager ──────────────────────────────────────────────────────────────

export class BrainManager {
  /**
   * Return the latest version of a file type for a project.
   * Returns null when no versions exist yet.
   */
  async getLatest(
    projectId: string,
    fileType: BrainFileType,
  ): Promise<SharedBrainFile | null> {
    const rows = await db
      .select()
      .from(sharedBrainFiles)
      .where(
        and(
          eq(sharedBrainFiles.projectId, projectId),
          eq(sharedBrainFiles.fileType, fileType),
        ),
      )
      .orderBy(desc(sharedBrainFiles.version))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Write a new version. The version number is max(existing) + 1, starting at 1.
   * Returns the newly created record.
   */
  async createVersion(
    projectId: string,
    fileType: BrainFileType,
    content: string,
    opts: {
      agentType?: string | undefined;
      modelUsed?: string | undefined;
      sessionId?: string | undefined;
    } = {},
  ): Promise<SharedBrainFile> {
    const maxRow = await db
      .select({ maxVer: max(sharedBrainFiles.version) })
      .from(sharedBrainFiles)
      .where(
        and(
          eq(sharedBrainFiles.projectId, projectId),
          eq(sharedBrainFiles.fileType, fileType),
        ),
      );

    const version = (maxRow[0]?.maxVer ?? 0) + 1;
    const id = crypto.randomUUID();

    await db.insert(sharedBrainFiles).values({
      id,
      projectId,
      fileType,
      fileName: `${fileType}-v${version}`,
      version,
      content,
      agentType: opts.agentType,
      modelUsed: opts.modelUsed,
    });

    logger.info({ projectId, fileType, version, agentType: opts.agentType }, "Brain file version created");

    const rows = await db
      .select()
      .from(sharedBrainFiles)
      .where(eq(sharedBrainFiles.id, id))
      .limit(1);

    return rows[0]!;
  }

  /**
   * All versions of a file type for a project, newest first.
   */
  async getHistory(
    projectId: string,
    fileType: BrainFileType,
  ): Promise<SharedBrainFile[]> {
    return db
      .select()
      .from(sharedBrainFiles)
      .where(
        and(
          eq(sharedBrainFiles.projectId, projectId),
          eq(sharedBrainFiles.fileType, fileType),
        ),
      )
      .orderBy(desc(sharedBrainFiles.version));
  }

  /**
   * Diff two version numbers of a file type.
   * v1 is the "from" (base), v2 is the "to" (target).
   * Throws 404 if either version doesn't exist.
   */
  async compareVersions(
    projectId: string,
    fileType: BrainFileType,
    v1: number,
    v2: number,
  ): Promise<VersionCompare> {
    const [fromRows, toRows] = await Promise.all([
      db
        .select()
        .from(sharedBrainFiles)
        .where(
          and(
            eq(sharedBrainFiles.projectId, projectId),
            eq(sharedBrainFiles.fileType, fileType),
            eq(sharedBrainFiles.version, v1),
          ),
        )
        .limit(1),
      db
        .select()
        .from(sharedBrainFiles)
        .where(
          and(
            eq(sharedBrainFiles.projectId, projectId),
            eq(sharedBrainFiles.fileType, fileType),
            eq(sharedBrainFiles.version, v2),
          ),
        )
        .limit(1),
    ]);

    const fromRow = fromRows[0];
    const toRow = toRows[0];
    if (!fromRow) throw new Error(`Version ${v1} of ${fileType} not found for project ${projectId}`);
    if (!toRow)   throw new Error(`Version ${v2} of ${fileType} not found for project ${projectId}`);

    const diff = lcsLineDiff(fromRow.content, toRow.content);
    const insertions = diff.filter((l) => l.type === "added").length;
    const deletions  = diff.filter((l) => l.type === "removed").length;

    return { fileType, fromVersion: v1, toVersion: v2, diff, insertions, deletions };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _brain: BrainManager | null = null;

export function getBrainManager(): BrainManager {
  if (_brain === null) _brain = new BrainManager();
  return _brain;
}
