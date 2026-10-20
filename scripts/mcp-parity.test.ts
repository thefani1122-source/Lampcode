import { readFileSync } from "node:fs";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

const dispatcher = readFileSync("src/agents/dispatcher.ts", "utf8");
const gateway = readFileSync("src/agents/model-gateway.ts", "utf8");
ok("both model providers use the same local read definitions", dispatcher.includes("buildReadToolDefinitions(report, mcpServers)") && !dispatcher.includes("effectiveProvider === \"modal\") {\n        const readTools"));
ok("write proxies remain approval-gated in the shared dispatcher", dispatcher.includes("buildWriteProxyDefinitions(report, mcpServers)") && dispatcher.includes("writeMcpRegistry: writeProxyRegistry"));
ok("dispatcher never sends remote MCP connector definitions to Anthropic", !dispatcher.includes("mcp_servers:") && !dispatcher.includes("mcpToolsets"));
ok("Anthropic gateway exposes only its standard local tool stream", !gateway.includes("beta.messages.create") && !gateway.includes("mcp_servers") && !gateway.includes("streamWithMcp"));
ok("relevance cap remains on both local read and write tool sets", (dispatcher.match(/capMcpTools\(/g) ?? []).length >= 2);

if (failures) process.exit(1);
console.log("All MCP provider-parity cases passed.");

