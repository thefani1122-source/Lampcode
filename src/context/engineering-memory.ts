/**
 * Structured Engineering Decision Memory
 *
 * Persists and selectively retrieves architectural decisions, bug fixes,
 * root-cause evidence, and verification status across build sessions.
 * Strictly scoped by project ID and redacts secrets before storage.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { engineeringDecisions } from "../db/schema.js";
import { logger } from "../server/logger.js";

export type ChangeType =
  | "feature"
  | "bugfix"
  | "refactor"
  | "architecture"
  | "config"
  | "dependency";

export type VerificationStatus = "verified" | "partially_verified" | "unverified";
export type DecisionConfidence = "high" | "medium" | "low";

export interface EngineeringDecisionRecord {
  id: string;
  projectId: string;
  buildSessionId?: string | null;
  changeType: ChangeType;
  userRequirement: string;
  observedFailure?: string | null;
  rootCause?: string | null;
  rationale: string;
  decision: string;
  implementation: string;
  affectedFiles: string[];
  affectedSymbols: string[];
  diffSummary?: string | null;
  verificationResult?: string | null;
  verificationStatus: VerificationStatus;
  confidence: DecisionConfidence;
  provenance: string;
  supersededBy?: string | null;
  supersedes: string[];
  tags: string[];
  createdAt: Date;
}

export interface DecisionSearchQuery {
  query?: string | undefined;
  changeType?: ChangeType | undefined;
  tag?: string | undefined;
  filePath?: string | undefined;
  symbol?: string | undefined;
  limit?: number | undefined;
}

export class EngineeringMemoryManager {
  // Short-lived process-local fallback, bounded by project and record count.
  private static memoryStore = new Map<string, Map<string, EngineeringDecisionRecord>>();
  private static readonly CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private static readonly MAX_CACHED_PROJECTS = 128;
  private static readonly MAX_RECORDS_PER_PROJECT = 100;

  private static pruneMemoryStore(): void {
    const now = Date.now();
    for (const [projectId, records] of this.memoryStore) {
      for (const [id, record] of records) {
        const createdAt = record.createdAt instanceof Date ? record.createdAt.getTime() : new Date(record.createdAt).getTime();
        if (!Number.isFinite(createdAt) || now - createdAt > this.CACHE_TTL_MS) records.delete(id);
      }
      if (records.size === 0) this.memoryStore.delete(projectId);
    }
    while (this.memoryStore.size > this.MAX_CACHED_PROJECTS) {
      const oldestProject = this.memoryStore.keys().next().value as string | undefined;
      if (!oldestProject) break;
      this.memoryStore.delete(oldestProject);
    }
  }

  private static cacheRecord(record: EngineeringDecisionRecord): void {
    this.pruneMemoryStore();
    let projectCache = this.memoryStore.get(record.projectId);
    if (!projectCache) {
      projectCache = new Map();
      this.memoryStore.set(record.projectId, projectCache);
    }
    projectCache.delete(record.id);
    projectCache.set(record.id, record);
    // Refresh project insertion order (simple LRU by project activity).
    this.memoryStore.delete(record.projectId);
    this.memoryStore.set(record.projectId, projectCache);
    while (projectCache.size > this.MAX_RECORDS_PER_PROJECT) {
      const oldestId = projectCache.keys().next().value as string | undefined;
      if (!oldestId) break;
      projectCache.delete(oldestId);
    }
    this.pruneMemoryStore();
  }

  private static redactSecrets(text: string): string {
    if (!text) return "";
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/, 1)[0]} [REDACTED_CREDENTIAL]`)
      .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_SECRET]")
      .replace(/([?&](?:token|key|secret|password|api_key)=)[^&\s]+/gi, "$1[REDACTED_SECRET]")
      .replace(/\b(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED_SECRET]")
      .replace(/\b(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED_SECRET]@");
  }

  private static redactStringArray(values: string[] | undefined, maxItems: number): string[] {
    return (values ?? []).filter((value): value is string => typeof value === "string")
      .slice(0, maxItems).map((value) => this.redactSecrets(value).slice(0, 500));
  }

  private static matchesQuery(record: EngineeringDecisionRecord, query: DecisionSearchQuery): boolean {
    if (query.changeType && record.changeType !== query.changeType) return false;
    if (query.query) {
      const q = query.query.toLowerCase();
      if (![record.userRequirement, record.decision, record.rationale, record.rootCause ?? ""]
        .some((value) => value.toLowerCase().includes(q))) return false;
    }
    if (query.filePath) {
      const fp = query.filePath.toLowerCase();
      if (!record.affectedFiles.some((value) => value.toLowerCase().includes(fp))) return false;
    }
    if (query.symbol) {
      const symbol = query.symbol.toLowerCase();
      if (!record.affectedSymbols.some((value) => value.toLowerCase().includes(symbol))) return false;
    }
    if (query.tag && !record.tags.includes(query.tag)) return false;
    return true;
  }

  /**
   * Record a new engineering decision.
   * Root causes are only stored when verified by evidence; otherwise marked "unknown".
   */
  static async recordDecision(params: {
    projectId: string;
    buildSessionId?: string | null;
    changeType: ChangeType;
    userRequirement: string;
    observedFailure?: string | null;
    rootCause?: string | null;
    rationale: string;
    decision: string;
    implementation: string;
    affectedFiles?: string[];
    affectedSymbols?: string[];
    diffSummary?: string | null;
    verificationResult?: string | null;
    verificationStatus?: VerificationStatus;
    confidence?: DecisionConfidence;
    provenance?: string;
    supersedes?: string[];
    tags?: string[];
  }): Promise<EngineeringDecisionRecord> {
    if (!params.projectId) {
      throw new Error("EngineeringMemoryManager: projectId is required");
    }

    const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const record: EngineeringDecisionRecord = {
      id,
      projectId: params.projectId,
      buildSessionId: params.buildSessionId ?? null,
      changeType: params.changeType,
      userRequirement: this.redactSecrets(params.userRequirement),
      observedFailure: params.observedFailure ? this.redactSecrets(params.observedFailure) : null,
      // Root cause is retained only when the captured decision itself carries
      // verified evidence. Otherwise do not turn an agent hypothesis into fact.
      rootCause: params.verificationStatus === "verified" && params.rootCause
        ? this.redactSecrets(params.rootCause)
        : "unknown",
      rationale: this.redactSecrets(params.rationale),
      decision: this.redactSecrets(params.decision),
      implementation: this.redactSecrets(params.implementation),
      affectedFiles: this.redactStringArray(params.affectedFiles, 100),
      affectedSymbols: this.redactStringArray(params.affectedSymbols, 100),
      diffSummary: params.diffSummary ? this.redactSecrets(params.diffSummary) : null,
      verificationResult: params.verificationResult ? this.redactSecrets(params.verificationResult) : null,
      verificationStatus: params.verificationStatus ?? "unverified",
      confidence: params.confidence ?? "medium",
      provenance: params.provenance ?? "agent_execution",
      supersededBy: null,
      supersedes: (params.supersedes ?? []).filter((id) => typeof id === "string").slice(0, 50),
      tags: this.redactStringArray(params.tags, 30),
      createdAt: new Date(),
    };

    // Cache the sanitized record before attempting persistence; this is the
    // bounded fallback if the database is temporarily unavailable.
    this.cacheRecord(record);
    const projectCache = this.memoryStore.get(params.projectId);

    // If supersedes, update local cache when the project is still retained.
    if (record.supersedes.length > 0 && projectCache) {
      for (const supId of record.supersedes) {
        const old = projectCache.get(supId);
        if (old) old.supersededBy = id;
      }
    }

    // Persist to database if available
    try {
      await db.insert(engineeringDecisions).values({
        id: record.id,
        projectId: record.projectId,
        buildSessionId: record.buildSessionId,
        changeType: record.changeType,
        userRequirement: record.userRequirement,
        observedFailure: record.observedFailure,
        rootCause: record.rootCause,
        rationale: record.rationale,
        decision: record.decision,
        implementation: record.implementation,
        affectedFiles: record.affectedFiles,
        affectedSymbols: record.affectedSymbols,
        diffSummary: record.diffSummary,
        verificationResult: record.verificationResult,
        verificationStatus: record.verificationStatus,
        confidence: record.confidence,
        provenance: record.provenance,
        supersededBy: record.supersededBy,
        supersedes: record.supersedes,
        tags: record.tags,
        createdAt: record.createdAt,
      });

      if (record.supersedes.length > 0) {
        for (const supId of record.supersedes) {
          await db
            .update(engineeringDecisions)
            .set({ supersededBy: id })
            .where(and(eq(engineeringDecisions.id, supId), eq(engineeringDecisions.projectId, params.projectId)))
            .catch(() => {});
        }
      }
    } catch (err) {
      logger.debug(
        { err, id, projectId: params.projectId },
        "EngineeringMemoryManager: DB insert skipped or unavailable (retained in-memory store)",
      );
    }

    return record;
  }

  /**
   * Search engineering decisions for a project by keyword, file path, symbol, or tag.
   */
  static async searchDecisions(
    projectId: string,
    query: DecisionSearchQuery,
  ): Promise<EngineeringDecisionRecord[]> {
    if (!projectId) return [];
    this.pruneMemoryStore();
    const limit = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 10)));
    const merged = new Map<string, EngineeringDecisionRecord>();

    // Fetch persistent records, but never return early: the process-local cache
    // may contain writes made while the DB was unavailable and they must remain
    // visible for the lifetime of that fallback cache.
    try {
      const rows = await db
        .select()
        .from(engineeringDecisions)
        .where(eq(engineeringDecisions.projectId, projectId))
        .orderBy(desc(engineeringDecisions.createdAt))
        .limit(Math.max(limit * 4, 50));
      for (const row of rows) {
        const record = {
          ...row,
          createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
          affectedFiles: Array.isArray(row.affectedFiles) ? row.affectedFiles : [],
          affectedSymbols: Array.isArray(row.affectedSymbols) ? row.affectedSymbols : [],
          supersedes: Array.isArray(row.supersedes) ? row.supersedes : [],
          tags: Array.isArray(row.tags) ? row.tags : [],
        } as unknown as EngineeringDecisionRecord;
        if (record.projectId === projectId) merged.set(record.id, record);
      }
    } catch {
      // A DB outage is expected to fall back to this process's bounded cache.
    }

    const projectCache = this.memoryStore.get(projectId);
    if (projectCache) {
      // Cache wins on duplicate IDs because it may contain a newer in-process
      // supersession update that could not be persisted during an outage.
      for (const record of projectCache.values()) {
        if (record.projectId === projectId) merged.set(record.id, record);
      }
    }

    return [...merged.values()]
      .filter((record) => record.projectId === projectId && this.matchesQuery(record, query))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /**
   * Get a single engineering decision strictly scoped to its project.
   */
  static async getDecision(
    id: string,
    projectId: string,
  ): Promise<EngineeringDecisionRecord | null> {
    if (!id || !projectId) return null;
    this.pruneMemoryStore();
    const cached = this.memoryStore.get(projectId)?.get(id);
    if (cached && cached.projectId === projectId) return cached;

    // Check DB first
    try {
      const rows = await db
        .select()
        .from(engineeringDecisions)
        .where(and(eq(engineeringDecisions.id, id), eq(engineeringDecisions.projectId, projectId)))
        .limit(1);

      if (rows && rows[0]) {
        const row = rows[0];
        const record = {
          ...row,
          createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
        } as unknown as EngineeringDecisionRecord;
        this.cacheRecord(record);
        return record;
      }
    } catch {
      // Fallback to cache
    }

    const projectCache = this.memoryStore.get(projectId);
    if (projectCache) {
      const record = projectCache.get(id);
      if (record && record.projectId === projectId) {
        return record;
      }
    }

    return null;
  }

  /**
   * Get historical engineering decisions affecting a specific file or symbol.
   */
  static async getSymbolHistory(
    projectId: string,
    target: string,
  ): Promise<EngineeringDecisionRecord[]> {
    if (!projectId || !target) return [];
    const lower = target.toLowerCase();
    const all = await this.searchDecisions(projectId, { limit: 20 });
    return all.filter((r) =>
      r.affectedSymbols.some((s) => s.toLowerCase().includes(lower)) ||
      r.affectedFiles.some((f) => f.toLowerCase().includes(lower)) ||
      r.decision.toLowerCase().includes(lower),
    ).slice(0, 5);
  }
}
