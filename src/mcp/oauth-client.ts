import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export interface McpOAuthSession {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function createMcpOAuthProvider(options: {
  serverUrl: string;
  redirectUrl: string;
  session: McpOAuthSession;
  persist: (session: McpOAuthSession) => Promise<void>;
  saveStateHash: (hash: string) => Promise<void>;
}) {
  let authorizationUrl: URL | undefined;
  const session = options.session;
  const clientMetadata: OAuthClientMetadata = {
    client_name: "Lampcode",
    redirect_uris: [options.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const provider: OAuthClientProvider = {
    get redirectUrl() { return options.redirectUrl; },
    get clientMetadata() { return clientMetadata; },
    async state() {
      const state = randomBytes(32).toString("base64url");
      await options.saveStateHash(hashOAuthState(state));
      return state;
    },
    clientInformation: () => session.clientInformation,
    async saveClientInformation(value) { session.clientInformation = value; await options.persist(session); },
    tokens: () => session.tokens,
    async saveTokens(value) { session.tokens = value; await options.persist(session); },
    async redirectToAuthorization(url) { authorizationUrl = url; },
    async saveCodeVerifier(value) { session.codeVerifier = value; await options.persist(session); },
    async codeVerifier() {
      if (!session.codeVerifier) throw new Error("OAuth verifier unavailable");
      return session.codeVerifier;
    },
    async validateResourceURL(_server, resource) {
      if (!resource) return new URL(options.serverUrl);
      const candidate = new URL(resource);
      const expected = new URL(options.serverUrl);
      if (candidate.origin !== expected.origin) throw new Error("OAuth resource does not match the MCP server");
      return candidate;
    },
    async saveDiscoveryState(value) { session.discoveryState = value; await options.persist(session); },
    discoveryState: () => session.discoveryState,
    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "tokens") delete session.tokens;
      if (scope === "all" || scope === "client") delete session.clientInformation;
      if (scope === "all" || scope === "verifier") delete session.codeVerifier;
      if (scope === "all" || scope === "discovery") delete session.discoveryState;
      await options.persist(session);
    },
  };
  return { provider, session, authorizationUrl: () => authorizationUrl };
}

