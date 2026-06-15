// Shared helpers for MCP provider integrations (WordPress, Shopify, Make, n8n,
// Zapier, …). Each provider module exports a `ProviderDef` registered in
// ./index.ts. Credentials are validated with a Zod schema, tested with
// testConnection(), and encrypted at rest by the connect route (env-crypto).

import { z } from "zod";

/** Retries a fetch/operation up to `attempts` times with linear backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

/** A fetch with a timeout + retry, throwing on non-2xx. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<unknown> {
  return withRetry(async () => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("application/json") ? res.json() : res.text();
  }, attempts);
}

export interface ProviderField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  optional?: boolean;
  help?: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  category: string;
  emoji: string;
  description: string;
  /** Zod schema for the connection params. */
  schema: z.ZodTypeAny;
  /** UI fields for the connect form (frontend renders these). */
  fields: ProviderField[];
  /** Live credential check. Never throws. */
  testConnection: (params: Record<string, unknown>) => Promise<{ ok: boolean; error: string | null }>;
  /** Prompt keywords that should suggest this provider + trigger codegen. */
  keywords: RegExp;
  /** System-prompt guidance appended when keywords match (codegen pattern). */
  promptRule: string;
}
