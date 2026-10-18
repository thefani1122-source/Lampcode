import { codeIntel } from "./code-intel.js";
import { buildImportGraph } from "./import-graph.js";
import { backendEndpoints, declaredRoutes } from "./wiring.js";

export interface ImpactReport {
  symbol: string;
  callers: Array<{ path: string; line: number }>;
  routes: string[];
  endpoints: string[];
  tests: string[];
  untested: string[];
  crossesAuthBoundary: boolean;
  degraded: boolean;
  omitted: { callers: number; routes: number; endpoints: number; tests: number; untested: number };
}

const MAX_ITEMS = 25;
const TEST_PATH = /\.(?:test|spec)\.[jt]sx?$/i;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function bounded<T>(values: T[]): { shown: T[]; omitted: number } {
  return { shown: values.slice(0, MAX_ITEMS), omitted: Math.max(0, values.length - MAX_ITEMS) };
}

/** Build a bounded, deterministic one-hop impact report from in-memory files. */
export function impactAnalysis(files: Record<string, string>, symbol: string): ImpactReport {
  const normalizedFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) normalizedFiles[normalize(path)] = content;

  const intelligence = codeIntel(normalizedFiles, { symbol });
  const empty = (): ImpactReport => ({
    symbol,
    callers: [], routes: [], endpoints: [], tests: [], untested: [],
    crossesAuthBoundary: false,
    degraded: intelligence.degraded || (intelligence.referencesOmitted ?? 0) > 0,
    omitted: { callers: 0, routes: 0, endpoints: 0, tests: 0, untested: 0 },
  });
  if (!intelligence.definition) return empty();

  const roots = new Set<string>([intelligence.definition.path]);
  for (const reference of intelligence.references) roots.add(reference.path);

  const graph = buildImportGraph(normalizedFiles);
  const radius = new Set(roots);
  // One hop only: direct importers of the definition/reference files. Do not
  // walk importers of these importers, which would turn the whole app into a radius.
  for (const root of roots) {
    for (const importer of graph.importedBy[root] ?? []) radius.add(normalize(importer));
  }

  const sourcePaths = [...radius].filter((path) => !TEST_PATH.test(path)).sort((a, b) => a.localeCompare(b));
  const testPaths = new Set(Object.keys(normalizedFiles).filter((path) => TEST_PATH.test(path)));
  const coveringTests = new Set<string>();
  const coveredSources = new Set<string>();
  for (const sourcePath of sourcePaths) {
    for (const importer of graph.importedBy[sourcePath] ?? []) {
      const normalizedImporter = normalize(importer);
      if (testPaths.has(normalizedImporter)) {
        coveringTests.add(normalizedImporter);
        coveredSources.add(sourcePath);
      }
    }
  }

  const routeSet = new Set<string>();
  const endpointSet = new Set<string>();
  for (const path of sourcePaths) {
    const content = normalizedFiles[path];
    if (content === undefined) continue;
    for (const route of declaredRoutes(content)) routeSet.add(route);
    for (const endpoint of backendEndpoints(content)) endpointSet.add(endpoint);
  }

  const frontend = sourcePaths.some((path) => /^src\/(?:components|pages)\//i.test(path));
  const serverOrData = sourcePaths.some((path) => /^src\/(?:server|db)\//i.test(path));
  const callers = intelligence.references
    .map(({ path, line }) => ({ path: normalize(path), line }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const routes = [...routeSet].sort((a, b) => a.localeCompare(b));
  const endpoints = [...endpointSet].sort((a, b) => a.localeCompare(b));
  const tests = [...coveringTests].sort((a, b) => a.localeCompare(b));
  const untested = sourcePaths.filter((path) => !coveredSources.has(path));
  const boundedCallers = bounded(callers);
  const boundedRoutes = bounded(routes);
  const boundedEndpoints = bounded(endpoints);
  const boundedTests = bounded(tests);
  const boundedUntested = bounded(untested);

  return {
    symbol,
    callers: boundedCallers.shown,
    routes: boundedRoutes.shown,
    endpoints: boundedEndpoints.shown,
    tests: boundedTests.shown,
    untested: boundedUntested.shown,
    crossesAuthBoundary: frontend && serverOrData,
    degraded: intelligence.degraded || (intelligence.referencesOmitted ?? 0) > 0,
    omitted: {
      callers: boundedCallers.omitted + (intelligence.referencesOmitted ?? 0),
      routes: boundedRoutes.omitted,
      endpoints: boundedEndpoints.omitted,
      tests: boundedTests.omitted,
      untested: boundedUntested.omitted,
    },
  };
}

export function formatImpact(report: ImpactReport): string {
  const lines = [`Impact for ${report.symbol}:`];
  const addList = (label: string, values: string[], omitted: number): void => {
    lines.push(`${label} (${values.length}${omitted ? ` shown, ${omitted} omitted` : ""}):`);
    if (values.length === 0) lines.push("  none");
    else lines.push(...values.map((value) => `  - ${value}`));
  };
  lines.push(`Callers (${report.callers.length}${report.omitted.callers ? ` shown, ${report.omitted.callers} omitted` : ""}):`);
  if (report.callers.length === 0) lines.push("  none");
  else lines.push(...report.callers.map(({ path, line }) => `  - ${path}:${line}`));
  addList("Routes", report.routes, report.omitted.routes);
  addList("Endpoints", report.endpoints, report.omitted.endpoints);
  addList("Covering tests", report.tests, report.omitted.tests);
  addList("Untested files", report.untested, report.omitted.untested);
  lines.push(`Crosses frontend/server boundary: ${report.crossesAuthBoundary ? "yes" : "no"}`);
  if (report.degraded) lines.push("The analysis is incomplete; treat this impact radius as a lower bound.");
  return lines.join("\n");
}

