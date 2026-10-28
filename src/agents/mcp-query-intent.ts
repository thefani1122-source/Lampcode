/**
 * Conservative intent gate for read-only questions about connected services.
 *
 * This is deliberately not a generic "chat versus build" classifier. It only
 * opts into the isolated MCP query path when a prompt has both a read intent
 * and an integration-data target, and contains no clear external write or code
 * mutation request. Uncertain requests stay on the normal build/agent path.
 */

export interface McpQueryIntent {
  handled: boolean;
  reason: "read-only-service-query" | "not-a-read-only-service-query";
}

const READ_INTENT_RE =
  /\b(check|show|list|fetch|get|find|search|inspect|review|read|view|summari[sz]e|explain|tell\s+me|what|which|how\s+many|recent|latest|last|current|status|health|history|overview)\b/i;

const SERVICE_DATA_RE =
  /\b(deployments?|build\s+logs?|deploy\s+logs?|domains?|projects?|services?|previews?|releases?|errors?|exceptions?|issues?|pull\s*requests?|prs?|commits?|branches?|repositories|repos?|workflows?|executions?|scenarios?|products?|orders?|customers?|audiences?|campaigns?|emails?|messages?|calls?|pages?|documents?|notes?|files?|components?|design\s+files?|analytics|usage|transactions?|subscriptions?|invoices?|environments?|databases?|collections?|records?|posts?|sites?|functions?|workers?|dns|alerts?|incidents?)\b/i;

const CODE_MUTATION_RE =
  /\b(?:build|create|generate|implement|write|edit|modify|rewrite|refactor|change|fix|update)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|my|our|this|these)\s+)?(?:app|website|web\s+site|feature|component|page|dashboard|code|files?|repository|repo|implementation|bug|functionality|integration|project)\b/i;

const EXTERNAL_WRITE_RE =
  /\b(?:redeploy|publish|push|commit|merge|delete|remove|restart|rollback|trigger|send|provision|deploy\s+(?:to|this|it|the)|create\s+(?:a|an|the)?\s*(?:deployment|pull\s+request|issue|branch|repository|repo)|update\s+(?:the|my|our)?\s*(?:environment\s+variables?|settings|domains?|deployment|issue|pull\s+request)|change\s+(?:the|my|our)?\s*(?:settings|environment|domain|deployment))\b/i;

export function classifyMcpQueryIntent(prompt: string): McpQueryIntent {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text || !READ_INTENT_RE.test(text) || !SERVICE_DATA_RE.test(text)) {
    return { handled: false, reason: "not-a-read-only-service-query" };
  }
  if (CODE_MUTATION_RE.test(text) || EXTERNAL_WRITE_RE.test(text)) {
    return { handled: false, reason: "not-a-read-only-service-query" };
  }
  return { handled: true, reason: "read-only-service-query" };
}

/** Cheap client-side prefilter; the backend classifier remains authoritative. */
export function mayBeMcpQuery(prompt: string): boolean {
  return Boolean(prompt && READ_INTENT_RE.test(prompt) && SERVICE_DATA_RE.test(prompt));
}
