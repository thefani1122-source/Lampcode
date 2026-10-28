/**
 * Verified REST/API integrations that are shown in the existing MCP catalogue.
 *
 * These are deliberately not represented as remote MCP servers. Each adapter
 * owns its endpoint, auth scheme, input validation and a read-only credential
 * check. We store the same encrypted credentials in user_mcp_connections so
 * existing per-user connection isolation and disconnect UI remain consistent.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { userIntegrations, userMcpConnections } from "../db/schema.js";
import { decrypt } from "../server/env-crypto.js";
import { secureMcpFetch } from "./secure-fetch.js";
import { sanitizeMcpError } from "./health.js";

export type RestProviderSlug =
  | "netlify" | "railway" | "shopify" | "wordpress"
  | "mailchimp" | "resend" | "twilio" | "sendgrid"
  | "framer" | "mongodb";

export interface RestConnection {
  slug: RestProviderSlug;
  credentials: Record<string, string>;
  meta: Record<string, string>;
}

export interface RestTestResult {
  ok: boolean;
  error: string | null;
  meta: Record<string, string>;
}

type Fetcher = typeof fetch;

const schemas: Record<RestProviderSlug, z.ZodType<Record<string, string>>> = {
  netlify: z.object({ netlify_token: z.string().min(8) }).passthrough() as z.ZodType<Record<string, string>>,
  railway: z.object({ api_token: z.string().min(8) }).passthrough() as z.ZodType<Record<string, string>>,
  shopify: z.object({
    shopify_store_domain: z.string().regex(/^[a-z0-9-]+\.myshopify\.com$/i),
    shopify_admin_token: z.string().min(8),
  }).passthrough() as z.ZodType<Record<string, string>>,
  wordpress: z.object({
    wordpress_site_url: z.string().url(),
    wordpress_username: z.string().min(1),
    wordpress_app_password: z.string().min(8),
  }).passthrough() as z.ZodType<Record<string, string>>,
  mailchimp: z.object({ api_key: z.string().regex(/^.{8,}-[a-z0-9]+$/i) }).passthrough() as z.ZodType<Record<string, string>>,
  resend: z.object({ api_key: z.string().min(8) }).passthrough() as z.ZodType<Record<string, string>>,
  twilio: z.object({ account_sid: z.string().regex(/^AC[a-f0-9]{32}$/i), auth_token: z.string().min(8), phone_number: z.string().optional().default("") }).passthrough() as z.ZodType<Record<string, string>>,
  sendgrid: z.object({ api_key: z.string().min(8) }).passthrough() as z.ZodType<Record<string, string>>,
  // These two providers do not have a simple authenticated REST endpoint for
  // the fields in the current UI. They must not be marked connected by a shape
  // check alone. See testRestConnection() below.
  framer: z.object({ framer_api_token: z.string().min(8), framer_project_url: z.string().url().optional() }).passthrough() as z.ZodType<Record<string, string>>,
  mongodb: z.object({ connection_string: z.string().min(15) }).passthrough() as z.ZodType<Record<string, string>>,
};

export const REST_PROVIDER_SLUGS: readonly RestProviderSlug[] = [
  "netlify", "railway", "shopify", "wordpress", "mailchimp",
  "resend", "twilio", "sendgrid", "framer", "mongodb",
];

function safeMeta(slug: RestProviderSlug, credentials: Record<string, string>): Record<string, string> {
  switch (slug) {
    case "netlify": return { auth: "REST API", endpoint: "api.netlify.com" };
    case "railway": return { auth: "REST API", endpoint: "backboard.railway.com" };
    case "shopify": return { auth: "REST API", store: credentials.shopify_store_domain ?? "", endpoint: "myshopify.com" };
    case "wordpress": {
      let host = "";
      try { host = new URL(credentials.wordpress_site_url ?? "").host; } catch { /* invalid URLs are rejected by schema / test */ }
      return { auth: "REST API", site: host };
    }
    case "mailchimp": {
      const region = credentials.api_key?.match(/-([a-z0-9]+)$/i)?.[1] ?? "";
      return { auth: "REST API", endpoint: region ? `${region}.api.mailchimp.com` : "api.mailchimp.com" };
    }
    case "resend": return { auth: "REST API", endpoint: "api.resend.com" };
    case "twilio": return { auth: "REST API", account: credentials.account_sid ?? "", endpoint: "api.twilio.com" };
    case "sendgrid": return { auth: "REST API", endpoint: "api.sendgrid.com" };
    case "framer": {
      let host = "";
      try { host = new URL(credentials.framer_project_url ?? "").host; } catch { /* optional field */ }
      return { auth: "Server API", ...(host ? { project: host } : {}) };
    }
    case "mongodb": return { auth: "MongoDB driver" };
  }
}

function safeWordPressBase(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("WordPress site URL must be a public HTTPS URL");
  }
  return url.toString().replace(/\/+$/, "") + "/wp-json";
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  try { return JSON.stringify(body) ?? ""; } catch { return ""; }
}

async function requestJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; ok: boolean; data: unknown; text: string }> {
  const response = await fetcher(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await response.text().catch(() => "");
  let data: unknown = text;
  if (text) {
    try { data = JSON.parse(text); } catch { /* not JSON */ }
  }
  return { status: response.status, ok: response.ok, data, text };
}

function safeFailure(status: number, fallback: string): string {
  if (status === 401) return "Authentication failed. Check the API key/token and account identifier.";
  if (status === 403) return "The credential was rejected or lacks the required read permission.";
  if (status === 404) return "The provider endpoint or account resource was not found. Check the site/account URL.";
  if (status === 429) return "The provider rate-limited the request. Try again later.";
  if (status >= 500) return `The provider returned HTTP ${status}. Try again later.`;
  return fallback;
}

function checkGraphqlErrors(data: unknown): string | null {
  if (!data || typeof data !== "object") return "The provider returned an invalid GraphQL response.";
  const errors = (data as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const messages = errors.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).message : "").filter((v) => typeof v === "string");
  return sanitizeMcpError(messages.join("; ") || "The provider rejected the GraphQL request.");
}

/**
 * Tests the credentials with a non-mutating provider-specific request.
 * A failure never persists anything and response bodies are never logged.
 */
export async function testRestConnection(
  slug: string,
  input: Record<string, unknown>,
  fetcher: Fetcher = secureMcpFetch,
): Promise<RestTestResult> {
  if (!REST_PROVIDER_SLUGS.includes(slug as RestProviderSlug)) {
    return { ok: false, error: "This provider is not configured as a REST integration.", meta: {} };
  }
  const provider = slug as RestProviderSlug;
  const parsed = schemas[provider].safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; "), meta: {} };
  }
  const credentials = parsed.data;

  try {
    let response: { status: number; ok: boolean; data: unknown; text: string };
    switch (provider) {
      case "netlify":
        response = await requestJson(fetcher, "https://api.netlify.com/api/v1/user", {
          headers: { Authorization: `Bearer ${credentials.netlify_token}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Netlify credential verification failed."), meta: {} };
        break;
      case "railway":
        response = await requestJson(fetcher, "https://backboard.railway.com/graphql/v2", {
          method: "POST",
          headers: { Authorization: `Bearer ${credentials.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query LampCodeConnectionCheck { me { id name email } }" }),
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Railway credential verification failed."), meta: {} };
        {
          const gqlError = checkGraphqlErrors(response.data);
          if (gqlError) return { ok: false, error: gqlError, meta: {} };
        }
        break;
      case "shopify":
        response = await requestJson(fetcher, `https://${credentials.shopify_store_domain}/admin/api/2026-10/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": credentials.shopify_admin_token, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query LampCodeConnectionCheck { shop { id name } products(first: 1) { edges { node { id title } } } }" }),
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Shopify credential verification failed."), meta: {} };
        {
          const gqlError = checkGraphqlErrors(response.data);
          if (gqlError) return { ok: false, error: gqlError, meta: {} };
        }
        break;
      case "wordpress": {
        const base = safeWordPressBase(credentials.wordpress_site_url ?? "");
        const auth = Buffer.from(`${credentials.wordpress_username}:${credentials.wordpress_app_password}`).toString("base64");
        response = await requestJson(fetcher, `${base}/wp/v2/users/me?context=edit`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "WordPress credential verification failed."), meta: {} };
        break;
      }
      case "mailchimp": {
        const region = credentials.api_key.match(/-([a-z0-9]+)$/i)?.[1];
        if (!region) return { ok: false, error: "Mailchimp API key must include its data-center suffix (for example, -us19).", meta: {} };
        response = await requestJson(fetcher, `https://${region}.api.mailchimp.com/3.0/ping`, {
          headers: { Authorization: `Bearer ${credentials.api_key}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Mailchimp credential verification failed."), meta: {} };
        break;
      }
      case "resend":
        response = await requestJson(fetcher, "https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${credentials.api_key}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Resend credential verification failed. A sending-only key may not have domain-read access."), meta: {} };
        break;
      case "twilio":
        response = await requestJson(fetcher, `https://api.twilio.com/2010-04-01/Accounts/${credentials.account_sid}.json`, {
          headers: { Authorization: `Basic ${Buffer.from(`${credentials.account_sid}:${credentials.auth_token}`).toString("base64")}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "Twilio credential verification failed."), meta: {} };
        break;
      case "sendgrid":
        response = await requestJson(fetcher, "https://api.sendgrid.com/v3/scopes", {
          headers: { Authorization: `Bearer ${credentials.api_key}`, Accept: "application/json" },
        });
        if (!response.ok) return { ok: false, error: safeFailure(response.status, "SendGrid credential verification failed."), meta: {} };
        break;
      case "framer":
        return {
          ok: false,
          error: "Framer's official Server API uses the framer-api package and a project URL; this token-only REST form is not a valid HTTP API connection. No credentials were saved.",
          meta: {},
        };
      case "mongodb":
        return {
          ok: false,
          error: "MongoDB Atlas needs a MongoDB driver to authenticate and ping this connection string. This backend has no MongoDB driver installed, so the URI has not been saved as connected.",
          meta: {},
        };
    }

    return { ok: true, error: null, meta: safeMeta(provider, credentials) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Never return a request URL containing credentials, Basic header, or raw provider body.
    const safe = /URL|HTTPS|public/i.test(message)
      ? sanitizeMcpError(message)
      : "The provider could not be reached safely (network error or timeout).";
    return { ok: false, error: safe, meta: {} };
  }
}

/** Parses a stored REST connection but never returns a secret in metadata. */
export function parseRestConnection(slug: string, input: unknown, meta: unknown): RestConnection | null {
  if (!REST_PROVIDER_SLUGS.includes(slug as RestProviderSlug)) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const parsed = schemas[slug as RestProviderSlug].safeParse(input);
  if (!parsed.success) return null;
  const publicMeta = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, string> : {};
  return { slug: slug as RestProviderSlug, credentials: parsed.data, meta: publicMeta };
}


/**
 * Loads already-saved REST integrations from the encrypted connection store.
 * Also reads the older user_integrations rows for the two providers that used
 * the previous generic form, so users do not have to reconnect after upgrades.
 */
export async function getConnectedRestIntegrations(userId: string): Promise<RestConnection[]> {
  const rows = await db
    .select()
    .from(userMcpConnections)
    .where(and(eq(userMcpConnections.userId, userId), inArray(userMcpConnections.providerSlug, [...REST_PROVIDER_SLUGS])));
  const connections: RestConnection[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.isCustom) continue;
    try {
      const credentials = JSON.parse(decrypt({
        encrypted: row.encryptedCreds,
        iv: row.encryptedCredsIv,
        tag: row.encryptedCredsTag,
      })) as unknown;
      const connection = parseRestConnection(row.providerSlug, credentials, row.meta);
      if (!connection) continue;
      connections.push(connection);
      seen.add(connection.slug);
    } catch {
      // Never log decrypted credentials. A corrupt row stays unavailable.
    }
  }

  const legacyRows = await db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId));
  for (const row of legacyRows) {
    if (seen.has(row.provider) || !REST_PROVIDER_SLUGS.includes(row.provider as RestProviderSlug)) continue;
    const cfg = row.config;
    if (!cfg.encryptedCreds || !cfg.encryptedCredsIv || !cfg.encryptedCredsTag) continue;
    try {
      const parsed = JSON.parse(decrypt({
        encrypted: cfg.encryptedCreds,
        iv: cfg.encryptedCredsIv,
        tag: cfg.encryptedCredsTag,
      })) as Record<string, unknown>;
      const normalized: Record<string, unknown> = { ...parsed };
      if (row.provider === "wordpress") {
        normalized.wordpress_site_url ??= parsed.siteUrl;
        normalized.wordpress_username ??= parsed.username;
        normalized.wordpress_app_password ??= parsed.appPassword;
      } else if (row.provider === "shopify") {
        normalized.shopify_store_domain ??= parsed.shopDomain;
        normalized.shopify_admin_token ??= parsed.adminApiAccessToken;
      } else if (row.provider === "railway") {
        normalized.api_token ??= parsed.api_token;
      }
      const connection = parseRestConnection(row.provider, normalized, cfg.meta ?? {});
      if (connection) {
        connections.push(connection);
        seen.add(connection.slug);
      }
    } catch {
      // Legacy connection was unreadable; do not mark it working.
    }
  }

  return connections;
}
