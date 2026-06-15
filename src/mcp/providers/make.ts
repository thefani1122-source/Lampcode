import { z } from "zod";
import { fetchJson, withRetry, type ProviderDef } from "./_shared.js";

// ── Make.com — trigger scenarios via webhook ─────────────────────────────────

export const makeSchema = z.object({
  webhookUrl: z.string().url("Must be your Make.com webhook URL"),
  apiKey: z.string().min(1).optional(),
});
export type MakeParams = z.infer<typeof makeSchema>;

export async function triggerScenario(p: MakeParams, payload: Record<string, unknown>): Promise<unknown> {
  return fetchJson(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Fire-and-forget — returns immediately without awaiting the scenario. */
export function triggerScenarioAsync(p: MakeParams, payload: Record<string, unknown>): void {
  void fetch(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/** Requires a Make.com API key + the EU/US API base embedded in the key region. */
export async function getScenarioStatus(p: MakeParams, scenarioId: string, apiBase = "https://eu1.make.com/api/v2"): Promise<unknown> {
  if (!p.apiKey) throw new Error("Make.com API key required for scenario status");
  return fetchJson(`${apiBase}/scenarios/${scenarioId}`, {
    headers: { Authorization: `Token ${p.apiKey}` },
  });
}

export async function testConnection(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const parsed = makeSchema.safeParse(params);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const host = new URL(parsed.data.webhookUrl).host;
  if (!/make\.com$|integromat\.com$/i.test(host)) {
    return { ok: false, error: "URL doesn't look like a Make.com webhook (expected *.make.com)" };
  }
  try {
    // Reachability check — any HTTP response means the hook exists. We don't
    // POST real data (that would fire the scenario).
    await withRetry(async () => {
      const res = await fetch(parsed.data.webhookUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      if (res.status >= 500) throw new Error(`Make.com responded ${res.status}`);
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const make: ProviderDef = {
  id: "make",
  name: "Make.com",
  category: "Productivity",
  emoji: "🔗",
  description: "Trigger Make.com scenarios (automations) from your app via webhook, with optional API status checks.",
  schema: makeSchema,
  fields: [
    { key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://hook.eu1.make.com/xxxxxxxx" },
    { key: "apiKey", label: "API Key (optional)", type: "password", optional: true, help: "Only needed to query scenario status." },
  ],
  testConnection,
  keywords: /\b(make\.com|make automation|integromat)\b/i,
  promptRule: `MAKE.COM: trigger the user's Make scenario by POSTing JSON to their webhook:
  fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
Put the webhook URL in a backend env var (process.env.MAKE_WEBHOOK_URL) and call
it from a backend route — don't expose it in client code.`,
};
