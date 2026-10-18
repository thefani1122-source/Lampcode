import {
  formatSearchHits,
  parseExaSearchResponse,
  parseFirecrawlSearchResponse,
  normalizeSearchLimit,
} from "../src/agents/web-search.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

const exa = parseExaSearchResponse({ results: [{ title: "A", url: "https://a.example", highlights: [" highlighted ", "text"], summary: "summary", text: "body" }] });
check("valid Exa response parses", exa.length === 1 && exa[0]?.title === "A" && exa[0]?.url === "https://a.example");
check("Exa snippet prefers normalized highlights", exa[0]?.snippet === "highlighted text");

const fallbackFields = parseExaSearchResponse({ results: [
  { title: "Summary", url: "https://summary.example", summary: "  a  summary\nline ", text: "body" },
  { title: "Text", url: "https://text.example", text: " body text " },
] });
check("Exa snippet falls back from summary to text", fallbackFields[0]?.snippet === "a summary line" && fallbackFields[1]?.snippet === "body text");

const many = parseExaSearchResponse({ results: Array.from({ length: 20 }, (_, i) => ({ title: String(i), url: `https://${i}.example`, text: "snippet" })) });
check("20 provider results cap at five", many.length === 5);

const long = parseExaSearchResponse({ results: [{ title: "Long", url: "https://long.example", text: "x".repeat(2000) }] });
check("long normalized snippet caps at 300 characters", long[0]?.snippet.length === 300);

check("malformed Exa response returns no hits", parseExaSearchResponse({ results: "bad" }).length === 0);

const firecrawl = parseFirecrawlSearchResponse({ success: true, data: { web: [
  { title: "Fire", url: "https://fire.example", description: "  useful   description ", markdown: "long content" },
  { title: "Content", url: "https://content.example", markdown: "content fallback" },
] } });
check("Firecrawl description precedes content fallback", firecrawl[0]?.snippet === "useful description" && firecrawl[1]?.snippet === "content fallback");
check("Firecrawl malformed response returns no hits", parseFirecrawlSearchResponse({ success: false, data: { web: [] } }).length === 0);

check("empty formatting is readable", formatSearchHits([]) === "No search results found or search is unavailable.");
check("limit hard cap and invalid values are deterministic", normalizeSearchLimit(100) === 5 && normalizeSearchLimit(2.8) === 2 && normalizeSearchLimit(0) === 0 && normalizeSearchLimit(-1) === 0 && normalizeSearchLimit(Number.NaN) === 0 && normalizeSearchLimit(Number.POSITIVE_INFINITY) === 0);

console.log(`\n${checks} web-search checks passed`);
