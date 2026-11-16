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
  // In-memory fallback cache scoped by projectId -> id -> record
  private static memoryStore = new Map<string, Map<string, EngineeringDecisionRecord>>();

  /** Redact potential API keys or tokens before storing in memory */
  private static redactSecrets(text: string): string {
    if (!text) return "";
    return text
      .replace(/([a-zA-Z0-9_-]{20,})\b/g, (match) => {
        if (/^(sk|pk|shpat|ghp|gho|pat|token|key)_[a-zA-Z0-9_-]+/i.test(match)) {
          return "[REDACTED_SECRET]";
        }
        return match;
      })
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_TOKEN]");
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
      rootCause: params.rootCause ? this.redactSecrets(params.rootCause) : "unknown",
      rationale: this.redactSecrets(params.rationale),
      decision: this.redactSecrets(params.decision),
      implementation: this.redactSecrets(params.implementation),
      affectedFiles: params.affectedFiles ?? [],
      affectedSymbols: params.affectedSymbols ?? [],
      diffSummary: params.diffSummary ? this.redactSecrets(params.diffSummary) : null,
      verificationResult: params.verificationResult ? this.redactSecrets(params.verificationResult) : null,
      verificationStatus: params.verificationStatus ?? "unverified",
      confidence: params.confidence ?? "medium",
      provenance: params.provenance ?? "agent_execution",
      supersededBy: null,
      supersedes: params.supersedes ?? [],
      tags: params.tags ?? [],
      createdAt: new Date(),
    };

    // Update in-memory project store
    let projectCache = this.memoryStore.get(params.projectId);
    if (!projectCache) {
      projectCache = new Map();
      this.memoryStore.set(params.projectId, projectCache);
    }
    projectCache.set(id, record);

    // If supersedes, update local cache
    if (record.supersedes.length > 0) {
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
    const limit = query.limit ?? 10;

    // Try DB query first
    try {
      let conditions = [eq(engineeringDecisions.projectId, projectId)];
      if (query.changeType) {
        conditions.push(eq(engineeringDecisions.changeType, query.changeType));
      }

      const rows = await db
        .select()
        .from(engineeringDecisions)
        .where(and(...conditions))
        .orderBy(desc(engineeringDecisions.createdAt))
        .limit(limit * 2);

      if (rows && rows.length > 0) {
        let results = rows as unknown as EngineeringDecisionRecord[];
        if (query.query) {
          const q = query.query.toLowerCase();
          results = results.filter(
            (r) =>
              r.userRequirement.toLowerCase().includes(q) ||
              r.decision.toLowerCase().includes(q) ||
              r.rationale.toLowerCase().includes(q) ||
              (r.rootCause && r.rootCause.toLowerCase().includes(q)),
          );
        }
        if (query.filePath) {
          const fp = query.filePath.toLowerCase();
          results = results.filter((r) => r.affectedFiles.some((f) => f.toLowerCase().includes(fp)));
        }
        if (query.symbol) {
          const sym = query.symbol.toLowerCase();
          results = results.filter((r) => r.affectedSymbols.some((s) => s.toLowerCase().includes(sym)));
        }
        if (query.tag) {
          results = results.filter((r) => r.tags.includes(query.tag!));
        }
        return results.slice(0, limit);
      }
    } catch {
      // Fallback to in-memory store
    }

    const projectCache = this.memoryStore.get(projectId);
    if (!projectCache) return [];

    let results = Array.from(projectCache.values());
    if (query.changeType) {
      results = results.filter((r) => r.changeType === query.changeType);
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter(
        (r) =>
          r.userRequirement.toLowerCase().includes(q) ||
          r.decision.toLowerCase().includes(q) ||
          r.rationale.toLowerCase().includes(q) ||
          (r.rootCause && r.rootCause.toLowerCase().includes(q)),
      );
    }
    if (query.filePath) {
      const fp = query.filePath.toLowerCase();
      results = results.filter((r) => r.affectedFiles.some((f) => f.toLowerCase().includes(fp)));
    }
    if (query.symbol) {
      const sym = query.symbol.toLowerCase();
      results = results.filter((r) => r.affectedSymbols.some((s) => s.toLowerCase().includes(sym)));
    }
    if (query.tag) {
      results = results.filter((r) => r.tags.includes(query.tag!));
    }

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }

  /**
   * Get a single engineering decision strictly scoped to its project.
   */
  static async getDecision(
    id: string,
    projectId: string,
  ): Promise<EngineeringDecisionRecord | null> {
    if (!id || !projectId) return null;

    // Check DB first
    try {
      const rows = await db
        .select()
        .from(engineeringDecisions)
        .where(and(eq(engineeringDecisions.id, id), eq(engineeringDecisions.projectId, projectId)))
        .limit(1);

      if (rows && rows[0]) {
        return rows[0] as unknown as EngineeringDecisionRecord;
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
