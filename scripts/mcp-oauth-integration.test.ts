import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpOAuthProvider, type McpOAuthSession } from "../src/mcp/oauth-client.js";

let checks = 0;
function check(label: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`ok ${label}`);
}

const state = { registrations: 0, codes: 0, refreshes: 0, failRefresh: false };
let base = "";
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", base);
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    res.writeHead(404, { connection: "close" }).end();
    return;
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    }));
    return;
  }
  if (url.pathname === "/register" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const registration = JSON.parse(raw) as { redirect_uris?: string[] };
    state.registrations++;
    res.writeHead(201, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ client_id: "local-client", redirect_uris: registration.redirect_uris ?? [], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }));
    return;
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") === "authorization_code") {
      state.codes++;
      res.writeHead(200, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ access_token: "local-access", refresh_token: "local-refresh", token_type: "Bearer", expires_in: 1 }));
      return;
    }
    if (form.get("grant_type") === "refresh_token") {
      state.refreshes++;
      if (state.failRefresh) {
        res.writeHead(400, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600 }));
      return;
    }
  }
  res.writeHead(404, { connection: "close" }).end();
}

const server = createServer((req, res) => { void handle(req, res).catch(() => res.writeHead(500).end()); });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock OAuth server did not bind");
base = `http://127.0.0.1:${address.port}`;
const session: McpOAuthSession = {};
let persisted = 0;
const oauth = createMcpOAuthProvider({
  serverUrl: `${base}/mcp`,
  redirectUrl: `${base}/mcp/oauth/callback`,
  session,
  persist: async () => { persisted++; },
  saveStateHash: async () => undefined,
});
try {
  const start = await auth(oauth.provider, { serverUrl: `${base}/mcp`, fetchFn: fetch });
  check("local mock starts OAuth authorization", start === "REDIRECT");
  check("SDK registration and PKCE verifier are persisted", state.registrations === 1 && Boolean(session.codeVerifier) && persisted >= 2);
  check("authorization redirect carries state and PKCE challenge", Boolean(oauth.authorizationUrl()?.searchParams.get("state")) && oauth.authorizationUrl()?.searchParams.get("code_challenge_method") === "S256");

  const callback = await auth(oauth.provider, { serverUrl: `${base}/mcp`, authorizationCode: "local-code", fetchFn: fetch });
  check("OAuth callback exchanges the local authorization code", callback === "AUTHORIZED" && state.codes === 1);
  check("callback stores access and refresh tokens in the session", session.tokens?.access_token === "local-access" && session.tokens.refresh_token === "local-refresh");

  const refreshed = await auth(oauth.provider, { serverUrl: `${base}/mcp`, fetchFn: fetch });
  check("expired-session refresh uses the provider refresh token", refreshed === "AUTHORIZED" && state.refreshes === 1 && session.tokens?.access_token === "refreshed-access");
  check("refresh token survives a response that omits rotation", session.tokens?.refresh_token === "local-refresh");

  state.failRefresh = true;
  const failedSession: McpOAuthSession = { ...session, tokens: { ...session.tokens, access_token: "expired-access", token_type: "Bearer" } };
  const failing = createMcpOAuthProvider({ serverUrl: `${base}/mcp`, redirectUrl: `${base}/callback`, session: failedSession, persist: async () => undefined, saveStateHash: async () => undefined });
  const recovered = await auth(failing.provider, { serverUrl: `${base}/mcp`, fetchFn: fetch });
  check("failed refresh returns to authorization instead of using the expired access token", recovered === "REDIRECT" && Boolean(failing.authorizationUrl()));
} finally {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

console.log(`${checks} local OAuth integration checks passed`);

