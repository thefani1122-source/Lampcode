export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const MAX_HITS = 5;
const MAX_SNIPPET = 300;
const REQUEST_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && normalizedText(value)) return normalizedText(value);
  }
  return "";
}

function exaSnippet(result: Record<string, unknown>): string {
  const highlights = Array.isArray(result.highlights)
    ? result.highlights.filter((item): item is string => typeof item === "string" && !!normalizedText(item))
    : [];
  // Exa's query-focused highlights are preferred; summary and page text are
  // deterministic fallbacks when highlights were not requested or returned.
  return firstText(highlights.join(" "), result.summary, result.text).slice(0, MAX_SNIPPET);
}

function hitsFrom(items: unknown[], snippetFor: (item: Record<string, unknown>) => string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const value of items) {
    const item = record(value);
    if (!item) continue;
    const title = firstText(item.title);
    const url = firstText(item.url);
    if (!title || !url) continue;
    hits.push({ title, url, snippet: snippetFor(item) });
    if (hits.length === MAX_HITS) break;
  }
  return hits;
}

export function parseExaSearchResponse(value: unknown): SearchHit[] {
  const root = record(value);
  if (!root || !Array.isArray(root.results)) return [];
  return hitsFrom(root.results, exaSnippet);
}

export function parseFirecrawlSearchResponse(value: unknown): SearchHit[] {
  const root = record(value);
  const data = record(root?.data);
  if (root?.success !== true || !Array.isArray(data?.web)) return [];
  return hitsFrom(data.web, (item) =>
    firstText(item.description, item.markdown).slice(0, MAX_SNIPPET),
  );
}

export function formatSearchHits(hits: SearchHit[]): string {
  if (!Array.isArray(hits) || hits.length === 0) return "No search results found or search is unavailable.";
  return hits.slice(0, MAX_HITS).map((hit) => {
    const title = normalizedText(typeof hit.title === "string" ? hit.title : "");
    const url = normalizedText(typeof hit.url === "string" ? hit.url : "");
    const snippet = normalizedText(typeof hit.snippet === "string" ? hit.snippet : "").slice(0, MAX_SNIPPET);
    return `- ${title}\n  ${url}\n  ${snippet}`;
  }).join("\n");
}

function safeLog(provider: string, reason: string): void {
  console.warn(`[web-search] ${provider}: ${reason}`);
}

export function normalizeSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_HITS;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(MAX_HITS, Math.floor(limit));
}

async function requestJson(url: string, key: string, body: Record<string, unknown>, authHeader: string): Promise<{ ok: boolean; status?: number; value?: unknown; reason?: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [authHeader]: authHeader === "x-api-key" ? key : `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status, reason: "http" };
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: false, status: response.status, reason: "invalid-json" };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request-failed" };
  }
}

export async function webSearch(query: string, limit = MAX_HITS): Promise<SearchHit[]> {
  const count = normalizeSearchLimit(limit);
  if (count === 0 || typeof query !== "string" || !query.trim()) return [];
  let exaKey: string | undefined;
  let firecrawlKey: string | undefined;
  try {
    const { config } = await import("../server/config.js");
    exaKey = config.EXA_API_KEY;
    firecrawlKey = config.FIRECRAWL_API_KEY;
  } catch {
    safeLog("providers", "configuration unavailable");
    return [];
  }
  if (!exaKey && !firecrawlKey) {
    safeLog("providers", "no key configured");
    return [];
  }

  let failure = "unavailable";
  if (exaKey) {
    const response = await requestJson(
      "https://api.exa.ai/search",
      exaKey,
      { query: query.trim(), type: "auto", numResults: count, contents: { highlights: true } },
      "x-api-key",
    );
    if (response.ok) {
      const root = record(response.value);
      if (root && Array.isArray(root.results)) {
        const hits = parseExaSearchResponse(root);
        if (!root.results.length || hits.length) return hits.slice(0, count);
        failure = "invalid-results";
      } else failure = "invalid-response";
    } else failure = response.status ? `http-${response.status}` : response.reason ?? "request-failed";
  }

  if (firecrawlKey) {
    const response = await requestJson(
      "https://api.firecrawl.dev/v2/search",
      firecrawlKey,
      { query: query.trim(), limit: count, sources: ["web"], scrapeOptions: { formats: ["markdown"] } },
      "Authorization",
    );
    if (response.ok) {
      const root = record(response.value);
      const data = record(root?.data);
      if (root?.success === true && Array.isArray(data?.web)) {
        const hits = parseFirecrawlSearchResponse(root);
        if (!data.web.length || hits.length) return hits.slice(0, count);
        failure = "invalid-results";
      } else failure = "invalid-response";
    } else failure = response.status ? `http-${response.status}` : response.reason ?? "request-failed";
    safeLog("firecrawl", failure);
  } else if (exaKey) {
    safeLog("exa", failure);
  }
  return [];
}
