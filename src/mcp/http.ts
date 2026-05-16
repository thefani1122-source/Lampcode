import { McpError } from "./types.js";

export interface HttpResponse {
  status: number;
  data: unknown;
}

/**
 * Thin fetch wrapper with timeout and standard MCP error mapping.
 * Throws McpError on auth failures, rate limits, and network issues.
 */
export async function httpCall(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new McpError("NETWORK_ERROR", `Request timed out after ${timeoutMs}ms`);
    }
    throw new McpError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : String(err),
    );
  }
  clearTimeout(timer);

  const contentType = res.headers.get("content-type") ?? "";
  let data: unknown;
  try {
    data = contentType.includes("application/json")
      ? await res.json()
      : await res.text();
  } catch {
    data = null;
  }

  if (res.status === 401 || res.status === 403) {
    throw new McpError("AUTH_FAILED", `Authentication failed (HTTP ${res.status})`, res.status);
  }
  if (res.status === 429) {
    throw new McpError("RATE_LIMIT", "Rate limit exceeded", res.status);
  }
  if (res.status === 404) {
    throw new McpError("NOT_FOUND", "Resource not found (404)", res.status);
  }
  if (res.status >= 500) {
    throw new McpError("PROVIDER_ERROR", `Provider error (HTTP ${res.status})`, res.status);
  }

  return { status: res.status, data };
}

/** Build a query string from a partial record, omitting undefined values. */
export function qs(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
