/**
 * Engineering Memory Retrieval Tools
 *
 * Provides selective metadata-first retrieval of past engineering decisions,
 * bug fix rationales, and symbol history for the current project.
 */

import { EngineeringMemoryManager, type ChangeType } from "../../context/engineering-memory.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

export const searchEngineeringDecisionsHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  if (!ctx.projectId) {
    return "Engineering memory is project-scoped. No active project ID in current execution context.";
  }

  const query = typeof args["query"] === "string" ? args["query"] : undefined;
  const changeType = typeof args["change_type"] === "string" ? (args["change_type"] as ChangeType) : undefined;
  const filePath = typeof args["file_path"] === "string" ? args["file_path"] : undefined;
  const symbol = typeof args["symbol"] === "string" ? args["symbol"] : undefined;
  const tag = typeof args["tag"] === "string" ? args["tag"] : undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 10) : 5;

  const records = await EngineeringMemoryManager.searchDecisions(ctx.projectId, {
    query,
    changeType,
    filePath,
    symbol,
    tag,
    limit,
  });

  if (records.length === 0) {
    return "No engineering decisions matched the search criteria.";
  }

  const lines = [
    `Found ${records.length} engineering decision(s) for this project:`,
    ...records.map((r) => {
      const statusTag = r.verificationStatus === "verified" ? "[VERIFIED]" : `[${r.verificationStatus.toUpperCase()}]`;
      const supersededTag = r.supersededBy ? ` (SUPERSEDED by ${r.supersededBy})` : "";
      return `- ID: ${r.id} | Type: ${r.changeType} | ${statusTag}${supersededTag}\n  Requirement: ${r.userRequirement}\n  Decision: ${r.decision}\n  Rationale: ${r.rationale}\n  Root Cause: ${r.rootCause ?? "unknown"}`;
    }),
  ];

  return lines.join("\n");
};

export const getEngineeringDecisionHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  if (!ctx.projectId) {
    return "Engineering memory is project-scoped. No active project ID in current execution context.";
  }

  const id = typeof args["id"] === "string" ? args["id"] : "";
  if (!id) {
    return "Error: valid decision id is required.";
  }

  const record = await EngineeringMemoryManager.getDecision(id, ctx.projectId);
  if (!record) {
    return `Engineering decision with ID "${id}" not found in this project.`;
  }

  return [
    `=== ENGINEERING DECISION RECORD: ${record.id} ===`,
    `Project: ${record.projectId}`,
    `Type: ${record.changeType}`,
    `Status: ${record.verificationStatus.toUpperCase()}`,
    `Confidence: ${record.confidence}`,
    `Requirement: ${record.userRequirement}`,
    record.observedFailure ? `Observed Failure: ${record.observedFailure}` : null,
    `Root Cause: ${record.rootCause ?? "unknown"}`,
    `Rationale: ${record.rationale}`,
    `Decision: ${record.decision}`,
    `Implementation: ${record.implementation}`,
    record.affectedFiles.length ? `Affected Files: ${record.affectedFiles.join(", ")}` : null,
    record.affectedSymbols.length ? `Affected Symbols: ${record.affectedSymbols.join(", ")}` : null,
    record.diffSummary ? `Diff Summary: ${record.diffSummary}` : null,
    record.verificationResult ? `Verification Result: ${record.verificationResult}` : null,
    record.supersededBy ? `SUPERSEDED BY: ${record.supersededBy}` : null,
    record.supersedes.length ? `Supersedes: ${record.supersedes.join(", ")}` : null,
    record.tags.length ? `Tags: ${record.tags.join(", ")}` : null,
    `Created At: ${record.createdAt.toISOString()}`,
    `================================================`,
  ]
    .filter(Boolean)
    .join("\n");
};

export const getSymbolHistoryHandler: ToolHandler = async (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  if (!ctx.projectId) {
    return "Engineering memory is project-scoped. No active project ID in current execution context.";
  }

  const target = typeof args["target"] === "string" ? args["target"] : "";
  if (!target) {
    return "Error: target file path or symbol name is required.";
  }

  const history = await EngineeringMemoryManager.getSymbolHistory(ctx.projectId, target);
  if (history.length === 0) {
    return `No historical engineering decisions found affecting "${target}".`;
  }

  return [
    `Historical engineering changes affecting "${target}":`,
    ...history.map(
      (h) =>
        `- [${h.changeType.toUpperCase()}] ${h.id} (${h.createdAt.toISOString().slice(0, 10)}): ${h.decision}\n  Root cause: ${h.rootCause ?? "unknown"} | Status: ${h.verificationStatus}`,
    ),
  ].join("\n");
};
