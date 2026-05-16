import { z } from "zod";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { type AgentType, type Phase } from "./state-machine.js";
import { logger } from "../server/logger.js";

// ── Conflict data models ──────────────────────────────────────────────────────

const conflictTypeSchema = z.enum([
  "ENDPOINT_MISMATCH",
  "SCHEMA_DRIFT",
  "TYPE_MISMATCH",
]);
export type ConflictType = z.infer<typeof conflictTypeSchema>;

const endpointDefSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  requestBody: z.record(z.string(), z.string()).optional(),
  responseBody: z.record(z.string(), z.string()).optional(),
});
export type EndpointDef = z.infer<typeof endpointDefSchema>;

const schemaDefSchema = z.object({
  name: z.string(),
  fields: z.record(z.string(), z.string()),
});
export type SchemaDef = z.infer<typeof schemaDefSchema>;

const typeDefSchema = z.object({
  name: z.string(),
  definition: z.string(),
});
export type TypeDef = z.infer<typeof typeDefSchema>;

const agentOutputSchema = z.object({
  agentType: z.string() as z.ZodType<AgentType>,
  phase: z.string() as z.ZodType<Phase>,
  endpoints: z.array(endpointDefSchema).optional(),
  schemas: z.array(schemaDefSchema).optional(),
  types: z.array(typeDefSchema).optional(),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

// ── Conflict representation ───────────────────────────────────────────────────

export type ConflictDetail =
  | {
      type: "ENDPOINT_MISMATCH";
      agentA: AgentType;
      pathA: string;
      agentB: AgentType;
      pathB: string;
      method: string;
    }
  | {
      type: "SCHEMA_DRIFT";
      schemaName: string;
      field: string;
      agentA: AgentType;
      typeA: string;
      agentB: AgentType;
      typeB: string;
    }
  | {
      type: "TYPE_MISMATCH";
      typeName: string;
      agentA: AgentType;
      defA: string;
      agentB: AgentType;
      defB: string;
    };

export interface Conflict {
  id: string;
  detail: ConflictDetail;
  description: string;
}

export interface ResolutionResult {
  conflict: Conflict;
  resolved: boolean;
  confidence: number;
  resolution?: string | undefined;
  escalated: boolean;
}

// ── ConflictResolver ──────────────────────────────────────────────────────────

const AUTO_FIX_THRESHOLD = 0.95;

export class ConflictResolver {
  /** Detect all conflicts between a set of agent outputs. */
  detectConflicts(outputs: AgentOutput[]): Conflict[] {
    const conflicts: Conflict[] = [];
    conflicts.push(...this.detectEndpointMismatches(outputs));
    conflicts.push(...this.detectSchemaDrift(outputs));
    conflicts.push(...this.detectTypeMismatches(outputs));
    return conflicts;
  }

  /** Attempt to resolve a conflict. Auto-fixes if confidence ≥ 95%, otherwise escalates. */
  async resolveConflict(
    conflict: Conflict,
    sessionId: string,
    userId: string,
    projectId: string,
  ): Promise<ResolutionResult> {
    const { confidence, resolution } = this.computeResolution(conflict);
    const autoFixed = confidence >= AUTO_FIX_THRESHOLD && resolution !== undefined;

    const result: ResolutionResult = {
      conflict,
      resolved: autoFixed,
      confidence,
      resolution: autoFixed ? resolution : undefined,
      escalated: !autoFixed,
    };

    // Always log to audit_log
    const action = autoFixed ? "conflict.auto_resolved" : "conflict.escalated";
    await this.writeAudit(userId, projectId, sessionId, action, {
      conflictId: conflict.id,
      conflictType: conflict.detail.type,
      description: conflict.description,
      confidence,
      resolution: result.resolution,
    });

    if (autoFixed) {
      logger.info(
        { sessionId, conflictId: conflict.id, confidence },
        "Conflict auto-resolved",
      );
    } else {
      logger.warn(
        { sessionId, conflictId: conflict.id, confidence },
        "Conflict escalated to user",
      );
    }

    return result;
  }

  /** Resolve all conflicts from a phase, returning a summary. */
  async resolveAll(
    outputs: AgentOutput[],
    sessionId: string,
    userId: string,
    projectId: string,
  ): Promise<{ resolved: number; escalated: number; results: ResolutionResult[] }> {
    const conflicts = this.detectConflicts(outputs);
    const results: ResolutionResult[] = [];

    for (const conflict of conflicts) {
      const r = await this.resolveConflict(conflict, sessionId, userId, projectId);
      results.push(r);
    }

    return {
      resolved: results.filter((r) => r.resolved).length,
      escalated: results.filter((r) => r.escalated).length,
      results,
    };
  }

  // ── Detection ───────────────────────────────────────────────────────────────

  private detectEndpointMismatches(outputs: AgentOutput[]): Conflict[] {
    const conflicts: Conflict[] = [];

    // Collect all endpoints keyed by method
    type MethodEndpoints = Map<string, { agentType: AgentType; path: string }[]>;
    const byMethod: MethodEndpoints = new Map();

    for (const output of outputs) {
      for (const ep of output.endpoints ?? []) {
        const existing = byMethod.get(ep.method) ?? [];
        existing.push({ agentType: output.agentType, path: ep.path });
        byMethod.set(ep.method, existing);
      }
    }

    for (const [method, eps] of byMethod) {
      for (let i = 0; i < eps.length; i++) {
        for (let j = i + 1; j < eps.length; j++) {
          const a = eps[i];
          const b = eps[j];
          if (a === undefined || b === undefined) continue;

          const normA = normalizePath(a.path);
          const normB = normalizePath(b.path);

          // Flag as conflict if paths are similar but not identical after normalization
          const sim = stringSimilarity(normA, normB);
          if (sim > 0.6 && normA !== normB) {
            const detail: ConflictDetail = {
              type: "ENDPOINT_MISMATCH",
              agentA: a.agentType,
              pathA: a.path,
              agentB: b.agentType,
              pathB: b.path,
              method,
            };
            conflicts.push({
              id: crypto.randomUUID(),
              detail,
              description: `${method} endpoint mismatch: "${a.path}" vs "${b.path}"`,
            });
          }
        }
      }
    }

    return conflicts;
  }

  private detectSchemaDrift(outputs: AgentOutput[]): Conflict[] {
    const conflicts: Conflict[] = [];

    // Collect schemas by name
    const byName = new Map<string, { agentType: AgentType; def: SchemaDef }[]>();

    for (const output of outputs) {
      for (const schema of output.schemas ?? []) {
        const existing = byName.get(schema.name) ?? [];
        existing.push({ agentType: output.agentType, def: schema });
        byName.set(schema.name, existing);
      }
    }

    for (const [, versions] of byName) {
      for (let i = 0; i < versions.length; i++) {
        for (let j = i + 1; j < versions.length; j++) {
          const a = versions[i];
          const b = versions[j];
          if (a === undefined || b === undefined) continue;

          // Compare field types
          const allFields = new Set([
            ...Object.keys(a.def.fields),
            ...Object.keys(b.def.fields),
          ]);

          for (const field of allFields) {
            const typeA = a.def.fields[field];
            const typeB = b.def.fields[field];
            if (typeA !== typeB) {
              const detail: ConflictDetail = {
                type: "SCHEMA_DRIFT",
                schemaName: a.def.name,
                field,
                agentA: a.agentType,
                typeA: typeA ?? "(missing)",
                agentB: b.agentType,
                typeB: typeB ?? "(missing)",
              };
              conflicts.push({
                id: crypto.randomUUID(),
                detail,
                description:
                  `Schema drift on "${a.def.name}.${field}": ` +
                  `${a.agentType} uses "${typeA ?? "missing"}", ` +
                  `${b.agentType} uses "${typeB ?? "missing"}"`,
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  private detectTypeMismatches(outputs: AgentOutput[]): Conflict[] {
    const conflicts: Conflict[] = [];
    const byName = new Map<string, { agentType: AgentType; def: TypeDef }[]>();

    for (const output of outputs) {
      for (const typeDef of output.types ?? []) {
        const existing = byName.get(typeDef.name) ?? [];
        existing.push({ agentType: output.agentType, def: typeDef });
        byName.set(typeDef.name, existing);
      }
    }

    for (const [, versions] of byName) {
      for (let i = 0; i < versions.length; i++) {
        for (let j = i + 1; j < versions.length; j++) {
          const a = versions[i];
          const b = versions[j];
          if (a === undefined || b === undefined) continue;

          if (normalizeTypeDef(a.def.definition) !== normalizeTypeDef(b.def.definition)) {
            const detail: ConflictDetail = {
              type: "TYPE_MISMATCH",
              typeName: a.def.name,
              agentA: a.agentType,
              defA: a.def.definition,
              agentB: b.agentType,
              defB: b.def.definition,
            };
            conflicts.push({
              id: crypto.randomUUID(),
              detail,
              description: `Type mismatch on "${a.def.name}" between ${a.agentType} and ${b.agentType}`,
            });
          }
        }
      }
    }

    return conflicts;
  }

  // ── Resolution ───────────────────────────────────────────────────────────────

  private computeResolution(conflict: Conflict): {
    confidence: number;
    resolution?: string | undefined;
  } {
    const { detail } = conflict;

    if (detail.type === "ENDPOINT_MISMATCH") {
      const normA = normalizePath(detail.pathA);
      const normB = normalizePath(detail.pathB);

      // If one is the plural of the other, high confidence: use plural
      if (toPlural(normA) === normB || normA === toPlural(normB)) {
        const resolved = normA.length > normB.length ? normA : normB;
        return { confidence: 0.97, resolution: resolved };
      }

      // If they only differ in trailing slash
      if (normA.replace(/\/$/, "") === normB.replace(/\/$/, "")) {
        return { confidence: 0.99, resolution: normA.replace(/\/$/, "") };
      }

      return { confidence: stringSimilarity(normA, normB) };
    }

    if (detail.type === "SCHEMA_DRIFT") {
      const { typeA, typeB } = detail;
      // Widening: if one is a superset (e.g. "string | null" vs "string"), use wider
      if (typeA.includes(typeB)) return { confidence: 0.97, resolution: typeA };
      if (typeB.includes(typeA)) return { confidence: 0.97, resolution: typeB };
      // Union as fallback
      const sim = stringSimilarity(typeA, typeB);
      if (sim > 0.8) {
        return { confidence: 0.9, resolution: `${typeA} | ${typeB}` };
      }
      return { confidence: sim };
    }

    if (detail.type === "TYPE_MISMATCH") {
      const sim = stringSimilarity(
        normalizeTypeDef(detail.defA),
        normalizeTypeDef(detail.defB),
      );
      if (sim > 0.95) {
        return { confidence: sim, resolution: detail.defA };
      }
      return { confidence: sim };
    }

    return { confidence: 0 };
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  private async writeAudit(
    userId: string,
    projectId: string,
    sessionId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId,
      projectId,
      action,
      metadata: { ...metadata, sessionId },
      createdAt: new Date(),
    });
  }
}

// ── Pure utility functions ────────────────────────────────────────────────────

function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\/+$/, "").replace(/^\/+/, "/");
}

function toPlural(s: string): string {
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  if (!s.endsWith("s")) return s + "s";
  return s;
}

function normalizeTypeDef(def: string): string {
  return def.replace(/\s+/g, " ").trim();
}

// Levenshtein-based similarity, 0–1
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (row === undefined || prevRow === undefined) continue;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prevRow[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prevRow[j - 1] ?? 0) + cost,
      );
    }
  }

  const dist = dp[la]?.[lb] ?? Math.max(la, lb);
  return 1 - dist / Math.max(la, lb);
}
