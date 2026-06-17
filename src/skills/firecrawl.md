# Firecrawl Skill

**Canonical reference:** https://docs.firecrawl.dev

Firecrawl is always available as a platform MCP tool. Use it whenever the user's
request involves a URL, web content, or live data from an external site.

## When to Use Firecrawl

| Situation | Tool |
|-----------|------|
| User provides a URL to reference/clone | `firecrawl_scrape` |
| User says "build something like [site]" | `firecrawl_scrape` + `firecrawl_map` |
| User wants data from multiple pages | `firecrawl_crawl` |
| User wants to search the web for info | `firecrawl_search` |
| User wants structured data extracted | `firecrawl_extract` |
| User wants a site's URL structure | `firecrawl_map` |

## Tool Reference

### firecrawl_scrape
Scrape a single URL and return its content as clean markdown.

```
firecrawl_scrape({
  url: "https://example.com/page",
  formats: ["markdown"],          // "markdown" | "html" | "screenshot"
  onlyMainContent: true,          // strip nav/footer/ads (default true)
  waitFor: 2000,                  // ms to wait for JS to render (for SPAs)
  actions: [                      // optional browser automation
    { type: "click", selector: "#load-more" },
    { type: "wait", milliseconds: 1000 },
    { type: "scroll", direction: "down", amount: 500 }
  ]
})
```

Use this when:
- User pastes a URL and says "build something like this"
- User says "use this as reference: [url]"
- You need to read documentation from a specific page

### firecrawl_crawl
Crawl an entire site (or section) up to a depth/page limit.

```
firecrawl_crawl({
  url: "https://docs.example.com",
  maxDepth: 3,          // how many link levels deep (default 2)
  limit: 20,            // max pages to crawl
  includePaths: ["/docs/", "/api/"],   // restrict to these paths
  excludePaths: ["/blog/", "/changelog/"],
  formats: ["markdown"]
})
```

Use this when:
- User wants to clone or understand a full docs site
- You need to survey multiple pages of content

### firecrawl_map
Return the full URL structure of a site — fast, no content fetched.

```
firecrawl_map({
  url: "https://example.com",
  limit: 100,
  search: "pricing"    // optional: filter URLs by keyword
})
```

Use this first when exploring an unfamiliar site before deciding what to scrape.

### firecrawl_search
Web search that returns full page content, not just snippets.

```
firecrawl_search({
  query: "SaaS dashboard design patterns 2024",
  limit: 5,            // number of results
  formats: ["markdown"],
  lang: "en",
  country: "us"
})
```

Use this when:
- You need general web research
- Finding design inspiration or competitive analysis
- Looking up documentation you don't have a URL for

### firecrawl_extract
Extract structured data from a page using a schema.

```
firecrawl_extract({
  urls: ["https://example.com/pricing"],
  prompt: "Extract all pricing plans with name, price, and features",
  schema: {
    type: "object",
    properties: {
      plans: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "string" },
            features: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  }
})
```

## Best Practices

- **Always scrape the reference URL first** before writing any code that clones a design
- Use `onlyMainContent: true` (default) to strip chrome/ads and get just the page body
- Add `waitFor: 2000` for React/Vue SPAs that render content after initial load
- Use `firecrawl_map` to explore site structure before deciding what pages to scrape
- Scrape competitors' landing pages when user asks to "build something like X"
- Include scraped content verbatim in your response before building — show you used it
