import { INTERNAL_MCP_PROVIDERS, MCP_REGISTRY } from "../src/mcp/registry.js";
import { resolveCustomMcpAuth, resolveMcpAuth } from "../src/mcp/connection.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
function ok(name: string, value: boolean): void { check(name, value, true); }

check("GitHub uses its documented bearer credential", resolveMcpAuth(MCP_REGISTRY.github!, { github_token: "ghp_test" })?.headers,
  { Authorization: "Bearer ghp_test" });
check("Stitch does not invent a static API-key header for its OAuth flow", resolveMcpAuth(MCP_REGISTRY["google-stitch"]!, {})?.headers, {});
check("embedded-token endpoint does not duplicate URL auth", resolveMcpAuth(MCP_REGISTRY.make!, { make_mcp_url: "https://eu2.make.com/mcp/stateless" })?.headers, {});
check("Exa public MCP does not require a fabricated key", resolveMcpAuth(INTERNAL_MCP_PROVIDERS.exa!, {})?.headers, {});
check("Vercel connection uses bearer access token", resolveMcpAuth(MCP_REGISTRY.vercel!, { vercel_token: "v_token" })?.headers,
  { Authorization: "Bearer v_token" });
check("Vercel advertises a static token field", MCP_REGISTRY.vercel!.credentialFields.length, 1);
check("Framer uses the hosted remote MCP endpoint", MCP_REGISTRY.framer!.mcpServerUrl, "https://mcp.framer.com/mcp");
check("MongoDB Atlas uses the managed MCP endpoint", MCP_REGISTRY.mongodb!.mcpServerUrl, "https://mcp.mongodb.com");
check("Netlify is explicitly registered as a REST adapter", MCP_REGISTRY.netlify!.supportsRealMCP, false);

for (const slug of ["notion", "figma", "sentry", "framer", "mongodb"] as const) {
  check(`${slug} hosted MCP uses OAuth`, MCP_REGISTRY[slug]!.authType, "oauth");
  check(`${slug} hosted MCP has no incompatible static credential form`, MCP_REGISTRY[slug]!.credentialFields, []);
}
check("custom server can use explicit header auth", resolveCustomMcpAuth({ url: "https://mcp.example.com/mcp", authType: "api_key", token: "k", headerName: "X-API-Key" })?.headers,
  { "X-API-Key": "k" });
ok("cleartext non-local custom MCP URLs are rejected", resolveCustomMcpAuth({ url: "http://mcp.example.com/mcp", authType: "none" }) === null);
ok("IPv6 loopback custom MCP URLs are rejected", resolveCustomMcpAuth({ url: "https://[::1]/mcp", authType: "none" }) === null);
ok("metadata service paths are rejected", resolveCustomMcpAuth({ url: "https://mcp.example.com/latest/meta-data", authType: "none" }) === null);
ok("malformed provider URLs are rejected", resolveMcpAuth({ mcpServerUrl: "not a url", authType: "none", credentialFields: [] }, {}) === null);

if (failures) process.exit(1);
console.log("All MCP connection resolution cases passed.");

