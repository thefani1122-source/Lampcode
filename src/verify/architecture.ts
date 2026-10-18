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
  | "file-too-large"
  | "duplicate-logic";

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

type Candidate = {
  path: string;
  line: number;
  name: string;
  signature: string;
};

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, out);
  }
}

function localIdentifierNames(node: ts.FunctionLikeDeclaration): string[] {
  const names: string[] = [];
  for (const parameter of node.parameters) bindingNames(parameter.name, names);
  const body = node.body;
  if (!body || !ts.isBlock(body)) return names;
  const visit = (current: ts.Node): void => {
    if (ts.isParameter(current)) bindingNames(current.name, names);
    else if (ts.isVariableDeclaration(current)) bindingNames(current.name, names);
    else if (ts.isFunctionDeclaration(current) && current.name) names.push(current.name.text);
    else if (ts.isClassDeclaration(current) && current.name) names.push(current.name.text);
    else if (ts.isCatchClause(current) && current.variableDeclaration) {
      bindingNames(current.variableDeclaration.name, names);
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return [...new Set(names)];
}

function propertyNamePositions(body: ts.Block): Set<number> {
  const positions = new Set<number>();
  const mark = (name: ts.PropertyName | undefined): void => {
    if (name && ts.isIdentifier(name)) positions.add(name.getStart());
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      positions.add(node.name.getStart());
    } else if (ts.isPropertyAssignment(node)) {
      mark(node.name);
    } else if (
      ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) ||
      ts.isMethodSignature(node) || ts.isPropertySignature(node) ||
      ts.isEnumMember(node)
    ) {
      mark(node.name);
    } else if (ts.isQualifiedName(node)) {
      positions.add(node.right.getStart());
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return positions;
}

function normalizedBody(body: ts.Block, locals: string[]): string {
  const localMap = new Map(locals.map((name, index) => [name, `v${index + 1}`]));
  const propertyPositions = propertyNamePositions(body);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body.getSourceFile().text);
  const start = body.getStart();
  const end = body.getEnd();
  scanner.setText(body.getSourceFile().text.slice(start, end));
  const tokens: string[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    let token = scanner.getTokenText();
    const absoluteStart = start + scanner.getTokenPos();
    if (
      kind === ts.SyntaxKind.Identifier &&
      !propertyPositions.has(absoluteStart) &&
      localMap.has(token)
    ) token = localMap.get(token) ?? token;
    tokens.push(`${kind}:${token}`);
    kind = scanner.scan();
  }
  return tokens.join("\u0001");
}

function isLiteralOrJsxReturn(body: ts.Block): boolean {
  if (body.statements.length !== 1) return false;
  const statement = body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
  let expression = statement.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword || ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression);
}

function functionName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  const named = "name" in node ? node.name : undefined;
  if (named && ts.isIdentifier(named)) return named.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return `<anonymous:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}>`;
}

function duplicateCandidates(files: Record<string, string>): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [path, content] of Object.entries(sourceFilesOnly(files)).sort(([a], [b]) => a.localeCompare(b))) {
    const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
    // Mid-edit parse failures make exact body boundaries uncertain; skip this
    // file instead of sending a repair for a guessed duplicate.
    const parseDiagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    if (!parseDiagnostics || parseDiagnostics.length > 0) continue;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)) &&
        node.body && ts.isBlock(node.body) && node.body.statements.length >= 8 &&
        !isLiteralOrJsxReturn(node.body) &&
        !(node.body.statements.length === 1 && ts.isSwitchStatement(node.body.statements[0] as ts.Node))
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        candidates.push({
          path,
          line,
          name: functionName(node, source),
          signature: normalizedBody(node.body, localIdentifierNames(node)),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

function countDuplicateLogic(files: Record<string, string>): ArchitectureFinding[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of duplicateCandidates(files)) {
    const group = groups.get(candidate.signature);
    if (group) group.push(candidate);
    else groups.set(candidate.signature, [candidate]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => group.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line))
    .sort((a, b) => {
      const left = a[0];
      const right = b[0];
      return (left?.path ?? "").localeCompare(right?.path ?? "") || (left?.line ?? 0) - (right?.line ?? 0);
    })
    .map((group) => {
      const locations = group.map((item) => `${item.path}:${item.line} (${item.name})`);
      return {
        kind: "duplicate-logic",
        path: group[0]?.path ?? "",
        symbol: group.map((item) => item.name).join(", "),
        detail: `These function bodies are identical at ${locations.join(", ")}; extract the shared business logic into src/lib/ and call it from each location.`,
      };
    });
}

/** Find import cycles, forbidden layer edges, oversized files, and exact duplicate logic. */
export function findArchitectureGaps(files: Record<string, string>): ArchitectureFinding[] {
  return [
    ...countCycles(files),
    ...countLayerViolations(files),
    ...countLargeFiles(files),
    ...countDuplicateLogic(files),
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

