import ts from "typescript";

const EMAIL_CONFIRMATION_GUIDANCE =
  "• Preview sign-up: this app uses Supabase email/password sign-up, but this preview URL changes with each build, so confirmation emails sent to the project's fixed Site URL will not return here. In Supabase Dashboard, open Authentication → Sign In / Providers → Email and switch off Confirm email to test sign-up in preview. That skips email verification, so turn Confirm email back on before launch.";

function propertyName(node: ts.PropertyName | ts.Expression): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function hasEmailPasswordSignUp(source: string, path: string): boolean {
  if (!/\.(?:[cm]?tsx?|[cm]?jsx?)$/i.test(path)) return false;
  if (/(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) return false;

  const kind = /\.tsx$|\.jsx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  // A parse error makes the call shape uncertain; skip this file to avoid a false warning.
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return false;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const signUp = node.expression;
      const auth = ts.isPropertyAccessExpression(signUp) && signUp.name.text === "signUp"
        ? signUp.expression
        : null;
      const client = auth && ts.isPropertyAccessExpression(auth) && auth.name.text === "auth"
        ? auth.expression
        : null;
      const input = node.arguments[0];

      if (client && input && ts.isObjectLiteralExpression(input)) {
        const keys = new Set(input.properties.flatMap((property) => {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const name = propertyName(property.name);
            return name ? [name] : [];
          }
          return [];
        }));
        found = keys.has("email") && keys.has("password");
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

function importsSupabaseClient(source: string, path: string): boolean {
  if (!/\.(?:[cm]?tsx?|[cm]?jsx?)$/i.test(path)) return false;
  if (/(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) return false;
  const kind = /\.tsx$|\.jsx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return false;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@supabase/supabase-js") {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Return preview guidance only when a connected Supabase app has email/password sign-up. */
export function formatPreviewEmailConfirmationGuidance(
  files: Record<string, string>,
  supabaseConnected: boolean,
): string | null {
  if (!supabaseConnected) return null;
  const sourceFiles = Object.entries(files);
  const hasSupabaseClient = sourceFiles.some(([path, source]) => importsSupabaseClient(source, path));
  return hasSupabaseClient && sourceFiles.some(([path, source]) => hasEmailPasswordSignUp(source, path))
    ? EMAIL_CONFIRMATION_GUIDANCE
    : null;
}
