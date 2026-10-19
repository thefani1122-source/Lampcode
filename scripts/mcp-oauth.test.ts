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

if (failures) process.exit(1);
console.log("All MCP OAuth provider cases passed.");

