import { readFileSync } from "node:fs";
import { INTERNAL_MCP_PROVIDERS } from "../src/mcp/registry.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

const dispatcher = readFileSync("src/agents/dispatcher.ts", "utf8");
const actionAgent = readFileSync("src/agents/mcp-action-agent.ts", "utf8");
const build = readFileSync("src/server/routes/build.ts", "utf8");
const integrations = readFileSync("src/server/routes/integrations.ts", "utf8");
ok("build dispatcher has no REST credential interpolation", !dispatcher.includes("rp.creds") && !dispatcher.includes("restContext"));
ok("action agent has no REST credential interpolation", !actionAgent.includes("rp.creds") && !actionAgent.includes("restContext"));
ok("build does not load REST provider secrets for model context", !build.includes("getConnectedRestProviders") && !build.includes("restProviders"));
ok("legacy REST secrets have no model-facing loader", !integrations.includes("getConnectedRestProviders") && !integrations.includes("ConnectedRestProvider"));
ok("Firecrawl uses its documented v2 MCP endpoint", build.includes("https://mcp.firecrawl.dev/v2/mcp") && actionAgent.includes("https://mcp.firecrawl.dev/v2/mcp"));
ok("Exa is treated as public and receives no fabricated API key", INTERNAL_MCP_PROVIDERS.exa?.authType === "none" && build.includes('url: "https://mcp.exa.ai/mcp", authToken: null'));

if (failures) process.exit(1);
console.log("All MCP credential-boundary cases passed.");

