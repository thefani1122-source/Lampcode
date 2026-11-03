import { INTERNAL_MCP_PROVIDERS, MCP_REGISTRY } from "../src/mcp/registry.js";
import { resolveCustomMcpAuth, resolveMcpAuth } from "../src/mcp/connection.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
function ok(name: string, value: boolean): void { check(name, value, true); }

check("GitHub's hosted MCP uses OAuth", MCP_REGISTRY.github!.authType, "oauth");
check("GitHub's hosted MCP has no static credential form", MCP_REGISTRY.github!.credentialFields, []);
check("GitHub OAuth session connects as bearer", resolveMcpAuth(MCP_REGISTRY.github!, { oauth_access_token: "gho_test" })?.headers,
  { Authorization: "Bearer gho_test" });
check("GitHub rows connected before the OAuth flip keep their PAT working", resolveMcpAuth(MCP_REGISTRY.github!, { github_token: "ghp_test" })?.headers,
  { Authorization: "Bearer ghp_test" });
check("an OAuth session wins over a leftover PAT in the same row", resolveMcpAuth(MCP_REGISTRY.github!, { oauth_access_token: "gho_new", github_token: "ghp_old" })?.headers,
  { Authorization: "Bearer gho_new" });
check("Stitch is a bearer-token provider, not OAuth", MCP_REGISTRY["google-stitch"]!.authType, "bearer_token");
check("Stitch asks for exactly one credential: the Stitch API key",
  MCP_REGISTRY["google-stitch"]!.credentialFields.map((f) => f.key), ["api_key"]);
check("Stitch connection uses the API key as a bearer token",
  resolveMcpAuth(MCP_REGISTRY["google-stitch"]!, { api_key: "st_key" })?.headers,
  { Authorization: "Bearer st_key" });
check("Stitch invents no header without a key", resolveMcpAuth(MCP_REGISTRY["google-stitch"]!, {}), null);
check("embedded-token endpoint does not duplicate URL auth", resolveMcpAuth(MCP_REGISTRY.make!, { make_mcp_url: "https://eu2.make.com/mcp/stateless" })?.headers, {});
check("Exa public MCP does not require a fabricated key", resolveMcpAuth(INTERNAL_MCP_PROVIDERS.exa!, {})?.headers, {});
check("Vercel connection uses bearer access token", resolveMcpAuth(MCP_REGISTRY.vercel!, { vercel_token: "v_token" })?.headers,
  { Authorization: "Bearer v_token" });
check("Vercel's hosted MCP has no static credential form after the OAuth flip", MCP_REGISTRY.vercel!.credentialFields, []);

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

