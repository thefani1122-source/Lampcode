import { z } from "zod";
import { fetchJson, withRetry, type ProviderDef } from "./_shared.js";

// ── Zapier — trigger Zaps via Catch Hook ─────────────────────────────────────

export const zapierSchema = z.object({
  webhookUrl: z.string().url("Must be your Zapier Catch Hook URL"),
  apiKey: z.string().min(1).optional(),
});
export type ZapierParams = z.infer<typeof zapierSchema>;

export async function triggerZap(p: ZapierParams, payload: Record<string, unknown>): Promise<unknown> {
  return fetchJson(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Fire-and-forget — sends data to the Zap without awaiting downstream apps. */
export function triggerZapAsync(p: ZapierParams, payload: Record<string, unknown>): void {
  void fetch(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/** Execution history via the Zapier REST API (needs an API key). */
export async function getZapRuns(p: ZapierParams, zapId: string): Promise<unknown> {
  if (!p.apiKey) throw new Error("Zapier API key required for run history");
  return fetchJson(`https://api.zapier.com/v1/zaps/${zapId}/runs`, {
    headers: { Authorization: `Bearer ${p.apiKey}` },
  });
}

export async function testConnection(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const parsed = zapierSchema.safeParse(params);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const host = new URL(parsed.data.webhookUrl).host;
  if (!/zapier\.com$/i.test(host)) {
    return { ok: false, error: "URL doesn't look like a Zapier hook (expected hooks.zapier.com)" };
  }
  try {
    // Zapier catch hooks accept GET with an empty 200 — reachability check.
    await withRetry(async () => {
      const res = await fetch(parsed.data.webhookUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (res.status >= 500) throw new Error(`Zapier responded ${res.status}`);
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const zapier: ProviderDef = {
  id: "zapier",
  name: "Zapier",
  category: "Productivity",
  emoji: "⚡",
  description: "Send data to 5000+ apps by triggering Zapier Zaps via a Catch Hook.",
  schema: zapierSchema,
  fields: [
    { key: "webhookUrl", label: "Catch Hook URL", type: "url", placeholder: "https://hooks.zapier.com/hooks/catch/xxxx/yyyy/" },
    { key: "apiKey", label: "API Key (optional)", type: "password", optional: true, help: "Only needed for run history via the Zapier REST API." },
  ],
  testConnection,
  keywords: /\bzapier\b/i,
  promptRule: `ZAPIER: trigger the user's Zap by POSTing JSON to their Catch Hook:
  fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
Keep the hook URL in a backend env var (process.env.ZAPIER_WEBHOOK_URL) and call
it from a backend route.`,
};
