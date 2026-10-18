import ts from "typescript";

export interface SymbolRef {
  path: string;
  line: number;
  text: string;
  /** True when this is only a lexical match from a file that did not parse. */
  degraded?: boolean;
}

export interface CodeIntelResult {
  definition?: SymbolRef;
  references: SymbolRef[];
  symbols?: Array<{ name: string; kind: string; line: number }>;
  /** Number of references beyond the returned cap. */
  referencesOmitted?: number;
  degraded: boolean;
}

const MAX_REFERENCES = 40;
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx)$/i;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node & { name?: ts.Node };
  if (parent.name !== node) return false;
  return ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) ||
    ts.isParameter(parent) || ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) || ts.isTypeParameterDeclaration(parent) ||
    ts.isModuleDeclaration(parent);
}

function sourceRefAt(source: ts.SourceFile, position: number, path: string, degraded = false): SymbolRef {
  const linePosition = source.getLineAndCharacterOfPosition(position);
  const line = source.text.split(/\r?\n/)[linePosition.line] ?? "";
  return {
    path,
    line: linePosition.line + 1,
    text: line.trim().slice(0, 240),
    ...(degraded ? { degraded: true } : {}),
  };
}

function sourceRef(source: ts.SourceFile, node: ts.Node, path: string): SymbolRef {
  return sourceRefAt(source, node.getStart(source), path);
}

/**
 * A parser failure makes checker identity unreliable for that file. The scanner
 * still skips comments and strings, so these are only possible code references.
 */
function textualReferences(source: ts.SourceFile, symbol: string, path: string): SymbolRef[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, source.languageVariant, source.text);
  const declarationKeywords = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.FunctionKeyword,
    ts.SyntaxKind.ClassKeyword,
    ts.SyntaxKind.InterfaceKeyword,
    ts.SyntaxKind.TypeKeyword,
    ts.SyntaxKind.EnumKeyword,
    ts.SyntaxKind.ConstKeyword,
    ts.SyntaxKind.LetKeyword,
    ts.SyntaxKind.VarKeyword,
  ]);
  const references: SymbolRef[] = [];
  let previous: ts.SyntaxKind | undefined;
  while (true) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (
      kind === ts.SyntaxKind.Identifier &&
      scanner.getTokenText() === symbol &&
      !declarationKeywords.has(previous as ts.SyntaxKind)
    ) {
      references.push(sourceRefAt(source, scanner.getTokenPos(), path, true));
    }
    previous = kind;
  }
  return references;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol;
}

function declarationIdentifier(declaration: ts.Declaration): ts.Identifier | undefined {
  const name = (declaration as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name : undefined;
}

function declarationKind(declaration: ts.Declaration, name: string, path: string): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    return /^[A-Z]/.test(name) && /\.[jt]sx$/i.test(path) ? "component" : "function";
  }
  if (ts.isClassDeclaration(declaration)) return "class";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent)) {
    return "constant";
  }
  return undefined;
}

/** Resolve symbols using only the supplied in-memory project files. */
export function codeIntel(
  files: Record<string, string>,
  query: { symbol?: string; path?: string },
): CodeIntelResult {
  const entries = Object.entries(files)
    .map(([path, text]) => [normalizePath(path), text] as const)
    .filter(([path]) => SOURCE_FILE_RE.test(path))
    .sort(([a], [b]) => a.localeCompare(b));
  const virtualRoot = "/__lampcode_memory__";
  const byVirtual = new Map<string, { path: string; text: string }>();
  const pathToVirtual = new Map<string, string>();
  for (const [path, text] of entries) {
    const virtual = `${virtualRoot}/${path}`;
    byVirtual.set(virtual, { path, text });
    pathToVirtual.set(path, virtual);
  }

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: false,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => virtualRoot;
  host.getCanonicalFileName = (fileName) => fileName.replace(/\\/g, "/");
  host.useCaseSensitiveFileNames = () => true;
  host.getNewLine = () => "\n";
  host.fileExists = (fileName) => byVirtual.has(fileName.replace(/\\/g, "/"));
  host.readFile = (fileName) => byVirtual.get(fileName.replace(/\\/g, "/"))?.text;
  host.directoryExists = (directoryName) => {
    const prefix = `${directoryName.replace(/\\/g, "/").replace(/\/$/, "")}/`;
    return [...byVirtual.keys()].some((fileName) => fileName.startsWith(prefix));
  };
  host.getDirectories = () => [];
  host.realpath = (fileName) => fileName.replace(/\\/g, "/");
  host.getSourceFile = (fileName, languageVersion) => {
    const item = byVirtual.get(fileName.replace(/\\/g, "/"));
    return item ? ts.createSourceFile(fileName, item.text, languageVersion, true) : undefined;
  };

  const roots = [...byVirtual.keys()].sort((a, b) => a.localeCompare(b));
  const program = ts.createProgram({ rootNames: roots, options, host });
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter((source) => byVirtual.has(source.fileName));
  const sourcePath = (source: ts.SourceFile) => byVirtual.get(source.fileName)?.path ?? "";
  const broken = new Set(sourceFiles.filter((source) =>
    ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0,
  ).map(sourcePath));

  if (query.path !== undefined) {
    const path = normalizePath(query.path);
    const virtual = pathToVirtual.get(path);
    const source = virtual ? program.getSourceFile(virtual) : undefined;
    if (!source || broken.has(path)) return { symbols: [], references: [], degraded: broken.size > 0 };
    const symbols: Array<{ name: string; kind: string; line: number }> = [];
    for (const statement of source.statements) {
      const declarations: ts.Declaration[] = [];
      if (
        ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) declarations.push(statement);
      else if (ts.isVariableStatement(statement)) declarations.push(...statement.declarationList.declarations);

      for (const declaration of declarations) {
        const name = declarationIdentifier(declaration);
        if (!name) continue;
        const kind = declarationKind(declaration, name.text, path);
        if (!kind) continue;
        // Skip non-exported top-level constants; they are implementation detail,
        // while named top-level functions and types remain useful path results.
        const statement = kind === "constant" ? declaration.parent.parent : declaration;
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        if (kind === "constant" && !modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const pos = source.getLineAndCharacterOfPosition(name.getStart(source));
        symbols.push({ name: name.text, kind, line: pos.line + 1 });
      }
    }
    return { symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)), references: [], degraded: broken.size > 0 };
  }

  if (!query.symbol) return { references: [], degraded: broken.size > 0 };
  const candidates = new Map<ts.Symbol, ts.Identifier>();
  for (const source of sourceFiles) {
    if (broken.has(sourcePath(source))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === query.symbol && isDeclarationName(node)) {
        // An import binding aliases the target symbol but is not its definition.
        if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent)) {
          ts.forEachChild(node, visit);
          return;
        }
        const resolved = symbolAt(checker, node);
        if (resolved) candidates.set(resolved, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A name alone cannot select between unrelated declarations. Returning an
  // empty result is safer than merging same-spelled local variables.
  if (candidates.size !== 1) return { references: [], degraded: broken.size > 0 };
  const [target, declarationNode] = [...candidates.entries()][0] as [ts.Symbol, ts.Identifier];
  const declarationSource = declarationNode.getSourceFile();
  const definition = sourceRef(declarationSource, declarationNode, sourcePath(declarationSource));
  const refs: SymbolRef[] = [];

  for (const source of sourceFiles) {
    const path = sourcePath(source);
    if (broken.has(path)) {
      refs.push(...textualReferences(source, query.symbol, path));
      continue;
    }
    const visit = (node: ts.Node): void => {
      const parent = node.parent;
      const importBinding = parent !== undefined && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent));
      if (ts.isIdentifier(node) && node.text === query.symbol && !isDeclarationName(node) && !importBinding) {
        if (symbolAt(checker, node) === target) refs.push(sourceRef(source, node, path));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  refs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.text.localeCompare(b.text));
  const referencesOmitted = Math.max(0, refs.length - MAX_REFERENCES);
  return {
    definition,
    references: refs.slice(0, MAX_REFERENCES),
    ...(referencesOmitted > 0 ? { referencesOmitted } : {}),
    degraded: broken.size > 0,
  };
}

export function formatCodeIntel(result: CodeIntelResult): string {
  if (result.symbols) {
    if (result.symbols.length === 0) return "No useful top-level symbols found.";
    return result.symbols.map((item) => `${item.kind} ${item.name} (line ${item.line})`).join("\n");
  }
  if (!result.definition) return result.degraded ? "No reliable symbol result; analysis was incomplete." : "Symbol not found or ambiguous.";
  return [
    `Definition: ${result.definition.path}:${result.definition.line}`,
    ...result.references.map((ref) => `${ref.degraded ? "Possible textual match" : "Reference"}: ${ref.path}:${ref.line} ${ref.text}`),
    ...(result.referencesOmitted ? [`… ${result.referencesOmitted} additional reference(s) omitted.`] : []),
    ...(result.degraded ? ["Analysis was incomplete because at least one source file could not be parsed."] : []),
  ].join("\n");
}

