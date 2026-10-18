/**
 * Deterministic architecture signals over the files already in memory.
 *
 * These checks stay deliberately structural: the import graph tells us what
 * depends on what, and duplicate logic is reported only when token-normalised
 * function bodies are exactly equal. A weaker match would turn a useful signal
 * into a repair dispatch that rewrites working code.
 */

import ts from "typescript";
import {
  buildImportGraph,
  importSpecifiers,
  resolveSpecifier,
} from "./import-graph.js";
import { stripComments } from "./dead-code.js";
import { templateOwnsFile } from "./review-units.js";

export type ArchitectureKind =
  | "circular-import"
  | "layer-violation"
  | "file-too-large";

export type ArchitectureFinding = {
  kind: ArchitectureKind;
  path: string;
  symbol: string;
  detail: string;
};

const CODE_PATH_RE = /\.(?:tsx?|jsx?|mts|mjs)$/i;
const TEST_PATH_RE = /\.(?:test|spec)\.[tj]sx?$/i;
const GENERATED_PATH_RE = /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.generated\.[^.]+$/i;

function normalise(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\\/g, "/");
}

function isSourcePath(path: string): boolean {
  return CODE_PATH_RE.test(path) && !path.endsWith(".d.ts") && !TEST_PATH_RE.test(path);
}

function sourceFilesOnly(files: Record<string, string>): Record<string, string> {
  const source: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (isSourcePath(path)) source[path] = stripComments(content);
  }
  return source;
}

function lineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r\n|\n|\r/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function countCycles(files: Record<string, string>): ArchitectureFinding[] {
  const source = sourceFilesOnly(files);
  const graph = buildImportGraph(source);
  const paths = Object.keys(source).sort();
  const known = new Set(paths);
  const edges = new Map<string, string[]>();

  for (const path of paths) {
    const targets = new Set(graph.imports[path] ?? []);
    // The shared graph intentionally drops self-edges. Resolve those with its
    // own parser/resolver so a one-file cycle is retained without a second parser.
    for (const spec of importSpecifiers(source[path] ?? "")) {
      if (resolveSpecifier(path, spec, known) === path) targets.add(path);
    }
    edges.set(path, [...targets].sort());
  }

  const cycles = new Map<string, string[]>();
  for (const start of paths) {
    const visit = (node: string, route: string[], active: Set<string>): void => {
      for (const next of edges.get(node) ?? []) {
        if (next === start) {
          const cycle = [...route, start];
          cycles.set(cycle.join("\u0000"), cycle);
          continue;
        }
        // Only the lexically smallest member may start a cycle walk. This
        // removes rotations while keeping distinct overlapping cycles visible.
        if (next < start || active.has(next)) continue;
        active.add(next);
        visit(next, [...route, next], active);
        active.delete(next);
      }
    };
    visit(start, [start], new Set([start]));
  }

  return [...cycles.values()]
    .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))
    .map((cycle) => ({
      kind: "circular-import",
      path: cycle[0] ?? "",
      symbol: cycle.join(" → "),
      detail: `Break this import cycle (${cycle.join(" → ")}) by extracting shared types or helpers into a lower-level module and removing one of the cycle's imports.`,
    }));
}

function countLayerViolations(files: Record<string, string>): ArchitectureFinding[] {
  const source = sourceFilesOnly(files);
  const graph = buildImportGraph(source);
  const findings: ArchitectureFinding[] = [];
  for (const path of Object.keys(source).sort()) {
    if (!path.startsWith("src/components/")) continue;
    for (const imported of [...(graph.imports[path] ?? [])].sort()) {
      if (!imported.startsWith("src/db/") && !imported.startsWith("src/server/")) continue;
      findings.push({
        kind: "layer-violation",
        path,
        symbol: imported,
        detail: `${path} imports ${imported}; move database or server access behind an API boundary and have the component call that API instead.`,
      });
    }
  }
  return findings;
}

function countLargeFiles(files: Record<string, string>): ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (!CODE_PATH_RE.test(path) || !isSourcePath(path)) continue;
    if (GENERATED_PATH_RE.test(path) || templateOwnsFile(path)) continue;
    const lines = lineCount(content);
    if (lines <= 600) continue;
    findings.push({
      kind: "file-too-large",
      path,
      symbol: `${lines} lines`,
      detail: `${path} has ${lines} lines; split it into smaller modules with one responsibility each so changes stay reviewable.`,
    });
  }
  return findings;
}

/** Find import cycles, forbidden layer edges, and oversized files. */
export function findArchitectureGaps(files: Record<string, string>): ArchitectureFinding[] {
  return [
    ...countCycles(files),
    ...countLayerViolations(files),
    ...countLargeFiles(files),
  ].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol),
  );
}

/** Format findings as actionable instructions for the model that must fix them. */
export function formatArchitectureGaps(findings: ArchitectureFinding[]): string {
  if (findings.length === 0) return "No architecture gaps found.";
  return [
    "Architecture findings — fix each issue while preserving existing behavior:",
    ...findings.map((finding) => `- ${finding.kind} in ${finding.path} (${finding.symbol}): ${finding.detail}`),
  ].join("\n");
}

