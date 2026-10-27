import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { safeMcpFailureCategory } from "../src/mcp/health.js";
import { resolveCustomMcpAuth } from "../src/mcp/connection.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`? ${name}`);
  else { failures++; console.log(`? ${name}\n    got: ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
check("HTTP status is a safe failure category", safeMcpFailureCategory(new StreamableHTTPError(401, "secret response")), "http_401");
check("timeout detail is reduced to a category", safeMcpFailureCategory(new Error("request timed out with token=secret")), "timeout");
check("unknown failures do not echo provider response text", safeMcpFailureCategory(new Error("token=secret body=private")), "transport_error");
check("custom URL rejects loopback addresses", resolveCustomMcpAuth({ url: "https://127.0.0.1/mcp", authType: "none" }), null);
check("custom URL rejects cloud metadata address", resolveCustomMcpAuth({ url: "https://169.254.169.254/latest/meta-data", authType: "none" }), null);
check("custom API key requires an explicit safe header name", resolveCustomMcpAuth({ url: "https://mcp.example.com/mcp", authType: "api_key", token: "secret" }), null);
const routes = readFileSync("src/server/routes/integrations.ts", "utf8");
const customStart = routes.indexOf('integrationsRouter.post("/mcp/custom/connect"');
const customCheck = routes.indexOf("const health = await checkMcpServer(resolved);", customStart);
const firstCustomPersist = routes.indexOf("await db.insert(userMcpConnections)", customCheck);
check("custom credentials are checked before persistence", customStart >= 0 && customCheck > customStart && firstCustomPersist > customCheck, true);
const providerStart = routes.indexOf('integrationsRouter.post("/mcp/:slug/connect"');
const providerCheck = routes.indexOf("const health = await checkMcpServer(resolved);", providerStart);
const providerPersist = routes.indexOf("await db.insert(userMcpConnections)", providerCheck);
check("registry provider credentials are checked before persistence", providerStart >= 0 && providerCheck > providerStart && providerPersist > providerCheck, true);
check("OAuth-only providers reject token-form connection attempts", routes.includes('if (provider.authType === "oauth") {') && routes.includes("OAUTH_REQUIRED"), true);
check("successful OAuth callbacks return to the MCP store", routes.includes('mcpOAuthReturnUrl("connected", pending.providerSlug)'), true);
if (failures) process.exit(1);
console.log("All MCP health-safety cases passed.");

