import { integrationsStatusHandler } from "../src/agents/tools/integrations-status.js";
import { AGENTIC_BUILD_TOOLS as TOOL_LIST } from "../src/agents/tools.js";
import { REGISTRY } from "../src/agents/tools/registry.js";
import { narrateTool } from "../src/agents/tool-narration.js";
import { MCP_REGISTRY } from "../src/mcp/registry.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

ok("integrations_status is defined in AGENTIC_BUILD_TOOLS", TOOL_LIST.some((t) => t.name === "integrations_status"));
ok("integrations_status has a registered handler", REGISTRY.has("integrations_status"));
ok("integrations_status is narrated", narrateTool("integrations_status").label.length > 0);

// No summary attached — say so, never invent.
const missing = await integrationsStatusHandler({}, {} as never);
ok("absent summary is reported as a wiring gap", missing.includes("No connection summary") && !missing.includes("GitHub —"));

// Empty account — an honest "nothing connected".
const empty = await integrationsStatusHandler({}, { connectedServices: [] } as never);
ok("empty account says nothing is connected", empty.includes("No services are connected"));

// A real account: GitHub PAT, Vercel OAuth WITH a REST token, Linear Notion
// Railway Cloudflare Sentry over OAuth.
const ctx = {
  connectedServices: [
    { slug: "github", name: "GitHub", source: "mcp", authType: "oauth", connectedAt: null },
    { slug: "vercel", name: "Vercel", source: "mcp", authType: "oauth", connectedAt: null, restToken: true },
    { slug: "linear", name: "Linear", source: "mcp", authType: "oauth", connectedAt: null },
    { slug: "notion", name: "Notion", source: "mcp", authType: "oauth", connectedAt: null },
    { slug: "railway", name: "Railway", source: "mcp", authType: "oauth", connectedAt: null },
    { slug: "cloudflare", name: "Cloudflare", source: "mcp", authType: "oauth", connectedAt: null },
    { slug: "sentry", name: "Sentry", source: "mcp", authType: "oauth", connectedAt: null },
  ],
} as never;
const full = await integrationsStatusHandler({}, ctx);
for (const name of ["GitHub", "Vercel", "Linear", "Notion", "Railway", "Cloudflare", "Sentry"]) {
  ok(`${name} appears as connected`, new RegExp(`- ${name} \\(github|\\(${name.toLowerCase()}\\)`.replace("github", "")).test(full) || full.includes(`(${name.toLowerCase()})`));
}
ok("Vercel reports a usable account token", full.includes("account token is available"));
ok("shopify is listed as NOT connected", full.includes("Shopify"));
ok("no markdown table is emitted", !full.includes("|"));

// Vercel connected but tokenless: the truth, with the fix named.
const tokenless = await integrationsStatusHandler({}, {
  connectedServices: [{ slug: "vercel", name: "Vercel", source: "mcp", authType: "oauth", connectedAt: null }],
} as never);
ok("tokenless Vercel says reconnect", tokenless.includes("reconnect Vercel"));

// Every catalogue provider either appears as connected or in the not-connected list.
const onlyGithub = await integrationsStatusHandler({}, {
  connectedServices: [{ slug: "github", name: "GitHub", source: "mcp", authType: "bearer_token", connectedAt: null }],
} as never);
const missingFromCatalogue = Object.values(MCP_REGISTRY)
  .filter((p) => p.name !== "GitHub" && !onlyGithub.includes(p.name))
  .map((p) => p.name);
ok(`every catalogue provider is accounted for${missingFromCatalogue.length ? ` (missing: ${missingFromCatalogue.join(", ")})` : ""}`, missingFromCatalogue.length === 0);

if (failures) process.exit(1);
