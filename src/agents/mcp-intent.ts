/**
 * Conservative intent routing for connected-service reads.
 *
 * This only recognises clearly observational requests. Any explicit mutation,
 * build, deployment, or code-edit verb excludes the request from query-only
 * mode. False negatives fall back to the existing build flow; the API repeats
 * the check so a caller cannot use this endpoint to run arbitrary operations.
 */
const READ_REQUEST = /\b(?:check|show|list|fetch|read|inspect|look(?:\s+up|\s+at)?|find|search|summari[sz]e|tell\s+me|what(?:\s+is|\s+are|['’]s|\s+happened|\s+did|\s+does)|how\s+many|which|when\s+(?:was|did|is)|where\s+is|give\s+me|display|review|what(?:'s|\s+are)\s+the\s+(?:latest|recent|current))\b/i;

const RECENCY_SIGNAL = /\b(?:recent|latest|newest|current|last|status|history|overview|summary|count|details|health|activity)\b/i;

const EXTERNAL_OBJECT = /\b(?:deployments?|projects?|domains?|environment\s+variables?|build\s+logs?|logs?|errors?|incidents?|issues?|pull\s+requests?|prs?|repositories|repos|branches|commits|workflows?|workflow\s+runs?|executions?|scenarios?|pages?|documents?|docs?|databases?|tables?|queries|products?|orders?|customers?|subscriptions?|payments?|billing|campaigns?|audiences?|emails?|messages?|sms|releases?|versions?|services?|zones?|workers?|buckets?|files?|design\s+files?|components?|events?|metrics|usage|transactions?|invoices?|refunds?|members?|users?|contacts?|records?)\b/i;

const MUTATION_REQUEST = /\b(?:build|create|write|edit|modify|change|update|delete|remove|destroy|publish|deploy|redeploy|rollback|restart|trigger|execute|run|send\s+(?:an?\s+)?(?:email|message|sms)|push|commit|merge|close|resolve|assign|refund|cancel|install|migrate|fix|repair|provision|add|rename|overwrite|create|launch|promote)\b/i;

/**
 * True only for a strong read/query intent over an external service.
 *
 * The provider/tool is still selected from authenticated connected servers
 * and actual discovered tool schemas; this helper is a routing guard, not a
 * replacement for tool selection or authorization.
 */
export function isReadOnlyMcpQuery(prompt: string): boolean {
  if (typeof prompt !== "string" || prompt.trim().length < 3 || prompt.length > 8_000) return false;
  const text = prompt.trim();
  if (MUTATION_REQUEST.test(text) || BUILD_OR_DEPLOY_ACTION.test(text) || WORKFLOW_ACTION.test(text)) return false;

  const hasReadSignal = READ_REQUEST.test(text) || RECENCY_SIGNAL.test(text);
  const hasExternalTarget = EXTERNAL_OBJECT.test(text);
  if (!hasReadSignal || !hasExternalTarget) return false;

  // A request to inspect source files is still an IDE/build task unless the
  // user clearly names a connected external service in that same request.
  const explicitlyNamesService = /\b(?:vercel|github|gitlab|railway|netlify|cloudflare|sentry|notion|figma|linear|stripe|shopify|wordpress|framer|mailchimp|resend|twilio|sendgrid|mongodb|supabase|n8n|zapier|make(?:\.com)?|google\s+stitch|stitch)\b/i.test(text);
  if (/\b(?:source|project|workspace|typescript|javascript)\s+files?\b/i.test(text) && !explicitlyNamesService) {
    return false;
  }
  return true;
}
