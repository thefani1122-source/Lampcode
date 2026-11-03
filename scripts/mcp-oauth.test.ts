import { createMcpOAuthProvider, hashOAuthState, type McpOAuthSession } from "../src/mcp/oauth-client.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

const session: McpOAuthSession = {};
let savedHash = "";
let persisted = 0;
const oauth = createMcpOAuthProvider({
  serverUrl: "https://mcp.example.com/mcp",
  redirectUrl: "https://lampcode.example/api/integrations/mcp/oauth/callback",
  session,
  persist: async () => { persisted++; },
  saveStateHash: async (hash) => { savedHash = hash; },
});
const state = await oauth.provider.state?.();
ok("state is generated with high entropy", typeof state === "string" && state.length >= 40);
ok("only the hash is persisted for callback matching", Boolean(state && savedHash === hashOAuthState(state)));
await oauth.provider.saveCodeVerifier("pkce-verifier");
ok("PKCE verifier is persisted in the encrypted session owner", session.codeVerifier === "pkce-verifier" && persisted === 1);
const sameOriginResource = await oauth.provider.validateResourceURL?.("https://mcp.example.com/mcp", "https://mcp.example.com/resource");
ok("same-origin OAuth resource is accepted", sameOriginResource?.href === "https://mcp.example.com/resource");
let crossOriginRejected = false;
try { await oauth.provider.validateResourceURL?.("https://mcp.example.com/mcp", "https://attacker.example/resource"); }
catch { crossOriginRejected = true; }
ok("cross-origin OAuth resource is rejected", crossOriginRejected);
ok("authorization redirect URL is not fabricated before SDK challenge", oauth.authorizationUrl() === undefined);

// No-DCR servers (GitHub) seed a pre-registered client: the SDK must skip
// dynamic registration and carry the auth method into the token exchange.
const staticSession: McpOAuthSession = {};
const staticOauth = createMcpOAuthProvider({
  serverUrl: "https://api.githubcopilot.com/mcp/",
  redirectUrl: "https://lampcode.example/api/integrations/mcp/oauth/callback",
  session: staticSession,
  persist: async () => undefined,
  saveStateHash: async () => undefined,
  staticClient: { clientId: "Iv1.static", clientSecret: "static-secret", tokenEndpointAuthMethod: "client_secret_post" },
});
const seeded = staticSession.clientInformation as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string } | undefined;
ok("static client is seeded so the SDK skips dynamic registration", seeded?.client_id === "Iv1.static" && seeded?.client_secret === "static-secret");
ok("the seeded client carries its token endpoint auth method", seeded?.token_endpoint_auth_method === "client_secret_post");
const reused: McpOAuthSession = { clientInformation: { client_id: "Iv1.existing" } as never };
createMcpOAuthProvider({
  serverUrl: "https://api.githubcopilot.com/mcp/",
  redirectUrl: "https://lampcode.example/api/integrations/mcp/oauth/callback",
  session: reused,
  persist: async () => undefined,
  saveStateHash: async () => undefined,
  staticClient: { clientId: "Iv1.static", clientSecret: "s", tokenEndpointAuthMethod: "client_secret_post" },
});
ok("an existing client registration is never overwritten", (reused.clientInformation as { client_id?: string }).client_id === "Iv1.existing");

if (failures) process.exit(1);
console.log("All MCP OAuth provider cases passed.");

