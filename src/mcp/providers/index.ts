// Registry of MCP provider integrations. Each provider is a self-contained
// module (Zod schema, testConnection, API helpers, prompt rule). The connect
// route and the prompt builder consume this registry generically.

import { type ProviderDef } from "./_shared.js";
import { wordpress } from "./wordpress.js";
import { shopify } from "./shopify.js";
import { make } from "./make.js";
import { n8n } from "./n8n.js";
import { zapier } from "./zapier.js";

export type { ProviderDef, ProviderField } from "./_shared.js";

export const PROVIDERS: Record<string, ProviderDef> = {
  [wordpress.id]: wordpress,
  [shopify.id]: shopify,
  [make.id]: make,
  [n8n.id]: n8n,
  [zapier.id]: zapier,
};

export const PROVIDER_LIST: ProviderDef[] = Object.values(PROVIDERS);

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS[id];
}

/**
 * Returns the prompt rules for every provider whose keywords appear in the
 * prompt — appended to the system prompt so generated apps include the right
 * integration code. `connectedIds` (optional) lets callers prioritise providers
 * the user has actually connected.
 */
export function matchProviderRules(prompt: string): string {
  const hits = PROVIDER_LIST.filter((p) => p.keywords.test(prompt));
  if (hits.length === 0) return "";
  return (
    "\n\n## CONNECTED-SERVICE INTEGRATIONS\n" +
    hits.map((p) => `- ${p.name}: ${p.promptRule}`).join("\n\n")
  );
}
