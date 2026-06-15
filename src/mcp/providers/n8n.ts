import { z } from "zod";
import { fetchJson, withRetry, type ProviderDef } from "./_shared.js";

// ── n8n — trigger workflows via webhook (self-hosted or cloud) ───────────────

export const n8nSchema = z.object({
  webhookUrl: z.string().url("Must be your n8n webhook URL"),
  apiKey: z.string().min(1).optional(),
});
export type N8nParams = z.infer<typeof n8nSchema>;

/** Synchronous: waits for the workflow's response (n8n "Respond to Webhook"). */
export async function triggerWorkflow(p: N8nParams, payload: Record<string, unknown>): Promise<unknown> {
  return fetchJson(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(p.apiKey ? { "X-N8N-API-KEY": p.apiKey } : {}) },
    body: JSON.stringify(payload),
  });
}

/** Fire-and-forget. */
export function triggerWorkflowAsync(p: N8nParams, payload: Record<string, unknown>): void {
  void fetch(p.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(p.apiKey ? { "X-N8N-API-KEY": p.apiKey } : {}) },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/** Poll an execution by id via the n8n REST API (needs apiKey + instance base). */
export async function waitForResponse(
  p: N8nParams,
  executionId: string,
  { timeoutMs = 30_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<unknown> {
  if (!p.apiKey) throw new Error("n8n API key required to poll executions");
  const origin = new URL(p.webhookUrl).origin;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exec = (await fetchJson(`${origin}/api/v1/executions/${executionId}`, {
      headers: { "X-N8N-API-KEY": p.apiKey },
    })) as { finished?: boolean; data?: unknown };
    if (exec.finished) return exec;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("n8n execution did not finish in time");
}

export async function testConnection(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const parsed = n8nSchema.safeParse(params);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  try {
    // Reachability only — don't fire the workflow with a real POST.
    await withRetry(async () => {
      const res = await fetch(parsed.data.webhookUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      if (res.status >= 500) throw new Error(`n8n responded ${res.status}`);
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const n8n: ProviderDef = {
  id: "n8n",
  name: "n8n",
  category: "Productivity",
  emoji: "⚙️",
  description: "Trigger n8n workflows from your app via webhook, synchronously or fire-and-forget.",
  schema: n8nSchema,
  fields: [
    { key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://your-n8n.app/webhook/xxxx" },
    { key: "apiKey", label: "API Key (optional)", type: "password", optional: true, help: "Only needed to poll execution results." },
  ],
  testConnection,
  keywords: /\bn8n\b/i,
  promptRule: `N8N: trigger the user's n8n workflow by POSTing JSON to their webhook:
  fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
For a synchronous result, the workflow should end with "Respond to Webhook".
Keep the webhook URL in a backend env var (process.env.N8N_WEBHOOK_URL).`,
};
