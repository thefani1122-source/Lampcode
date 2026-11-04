import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

/**
 * A pre-registered OAuth client for servers without dynamic client
 * registration (GitHub). The id and secret come from server env, never from
 * the user, and the auth method travels with the client so both the token
 * exchange and refresh use it.
 */
export interface StaticOAuthClient {
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic";
}

export interface McpOAuthSession {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  /**
   * Custom MCP OAuth flows ride the same transaction table: the display name
   * and description the user typed are stashed in the encrypted session so
   * the callback can build the final custom connection row without a schema
   * change.
   */
  customName?: string;
  customDescription?: string;
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
  /** Present for no-DCR servers: the SDK then skips dynamic registration. */
  staticClient?: StaticOAuthClient | undefined;
  /**
   * SEP-991 Client ID Metadata Document: an HTTPS URL where Lampcode hosts its
   * client metadata. When the server advertises
   * `client_id_metadata_document_supported`, the MCP SDK uses this URL as the
   * OAuth client_id instead of dynamic registration (e.g. Vercel).
   */
  clientMetadataUrl?: string | undefined;
}) {
  let authorizationUrl: URL | undefined;
  const session = options.session;
  const clientMetadata: OAuthClientMetadata = {
    client_name: "Lampcode",
    redirect_uris: [options.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: options.staticClient?.tokenEndpointAuthMethod ?? "none",
  };
  if (options.staticClient && !session.clientInformation) {
    session.clientInformation = {
      client_id: options.staticClient.clientId,
      client_secret: options.staticClient.clientSecret,
      token_endpoint_auth_method: options.staticClient.tokenEndpointAuthMethod,
    } as OAuthClientInformationMixed;
  }
  const provider: OAuthClientProvider = {
    get redirectUrl() { return options.redirectUrl; },
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
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

