import { createHash } from "crypto";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { logger } from "../server/logger.js";

type Phase = "IDLE" | "PLANNING" | "FOUNDATION" | "BUILD" | "VERIFY" | "DEPLOY";

// ── Freeze file schema ────────────────────────────────────────────────────────

const freezeEntrySchema = z.object({
  path: z.string(),
  hash: z.string().length(64), // SHA-256 hex
  sizeBytes: z.number().int().nonnegative(),
});
export type FreezeEntry = z.infer<typeof freezeEntrySchema>;

const freezeContractSchema = z.object({
  sessionId: z.string().uuid(),
  phase: z.string() as z.ZodType<Phase>,
  timestamp: z.string().datetime(),
  bundleHash: z.string().length(64), // SHA-256 over all file hashes
  files: z.array(freezeEntrySchema),
  agentSignatures: z.record(z.string(), z.string()),
});
export type FreezeContract = z.infer<typeof freezeContractSchema>;

// ── File input type ───────────────────────────────────────────────────────────

export interface FileInput {
  path: string;
  content: string;
}

export interface AgentSignature {
  agentType: string;
  outputHash: string;
}

// ── FreezeManager ─────────────────────────────────────────────────────────────

export class FreezeManager {
  private readonly baseDir: string;

  constructor(baseDir: string = join(process.cwd(), ".buildforge", "freezes")) {
    this.baseDir = baseDir;
  }

  /**
   * Called after a phase completes. Hashes all produced files, writes the
   * .freeze.json, and returns the contract. The next phase must call
   * readFreeze() before touching any workspace files.
   */
  async createFreeze(
    sessionId: string,
    phase: Phase,
    files: FileInput[],
    agentSignatures: AgentSignature[],
  ): Promise<FreezeContract> {
    const freezeDir = join(this.baseDir, sessionId);
    await mkdir(freezeDir, { recursive: true });

    const entries: FreezeEntry[] = files.map((f) => {
      const content = f.content;
      const hash = sha256(content);
      return {
        path: f.path,
        hash,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    });

    // Bundle hash: SHA-256 over all file hashes sorted by path for determinism
    const sortedHashes = [...entries]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => `${e.path}:${e.hash}`)
      .join("|");
    const bundleHash = sha256(sortedHashes);

    const signaturesRecord: Record<string, string> = {};
    for (const sig of agentSignatures) {
      signaturesRecord[sig.agentType] = sig.outputHash;
    }

    const contract: FreezeContract = {
      sessionId,
      phase,
      timestamp: new Date().toISOString(),
      bundleHash,
      files: entries,
      agentSignatures: signaturesRecord,
    };

    const validated = freezeContractSchema.parse(contract);
    const freezePath = this.freezePath(sessionId, phase);
    await writeFile(freezePath, JSON.stringify(validated, null, 2), "utf8");

    logger.info(
      { sessionId, phase, fileCount: entries.length, bundleHash },
      "Freeze contract created",
    );

    return validated;
  }

  /**
   * Read and verify a freeze contract. The next phase calls this to get the
   * immutable snapshot of the previous phase's outputs.
   */
  async readFreeze(sessionId: string, phase: Phase): Promise<FreezeContract> {
    const freezePath = this.freezePath(sessionId, phase);
    const raw = await readFile(freezePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const contract = freezeContractSchema.parse(parsed);

    // Re-verify the bundle hash to detect tampering
    const sortedHashes = [...contract.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => `${e.path}:${e.hash}`)
      .join("|");
    const recomputed = sha256(sortedHashes);

    if (recomputed !== contract.bundleHash) {
      throw new Error(
        `Freeze contract integrity failure for session ${sessionId} phase ${phase}: ` +
          `expected ${contract.bundleHash}, got ${recomputed}`,
      );
    }

    logger.debug({ sessionId, phase }, "Freeze contract verified");
    return contract;
  }

  /**
   * Verify that a set of live files matches a previously frozen contract.
   * Returns which files have drifted since the freeze.
   */
  async verifyFreeze(
    sessionId: string,
    phase: Phase,
    liveFiles: FileInput[],
  ): Promise<{ intact: boolean; drifted: string[] }> {
    const contract = await this.readFreeze(sessionId, phase);
    const frozenByPath = new Map(contract.files.map((e) => [e.path, e.hash]));
    const drifted: string[] = [];

    for (const file of liveFiles) {
      const liveHash = sha256(file.content);
      const frozenHash = frozenByPath.get(file.path);
      if (frozenHash === undefined || frozenHash !== liveHash) {
        drifted.push(file.path);
      }
    }

    return { intact: drifted.length === 0, drifted };
  }

  /** Check whether a freeze file exists for a given session + phase. */
  async freezeExists(sessionId: string, phase: Phase): Promise<boolean> {
    try {
      await access(this.freezePath(sessionId, phase));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the frozen file contents back from a contract for use by the next phase.
   * In a real system these would be fetched from object storage; here we re-read
   * from the workspace and verify against the freeze hash.
   */
  getFileHash(contract: FreezeContract, filePath: string): string | undefined {
    const entry = contract.files.find((e) => e.path === filePath);
    return entry?.hash;
  }

  private freezePath(sessionId: string, phase: Phase): string {
    return join(this.baseDir, sessionId, `${phase}.freeze.json`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
