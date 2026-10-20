import { legacyMcpActionBlocked } from "../src/agents/mcp-action-guard.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

check("legacy MCP path remains usable without user servers", !legacyMcpActionBlocked(0));
check("one user server is refused by the legacy path", legacyMcpActionBlocked(1));
check("multiple user servers are refused by the legacy path", legacyMcpActionBlocked(4));

console.log(`${checks} legacy MCP guard checks passed`);

