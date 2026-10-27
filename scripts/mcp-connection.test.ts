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
check("OAuth connection uses stored access token", resolveMcpAuth(MCP_REGISTRY.vercel!, { oauth_access_token: "oauth-token" })?.headers,
  { Authorization: "Bearer oauth-token" });
check("OAuth-only Vercel does not advertise a static token field", MCP_REGISTRY.vercel!.credentialFields, []);

for (const slug of ["notion", "figma", "sentry"] as const) {
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

