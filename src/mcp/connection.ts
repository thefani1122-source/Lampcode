import type { McpProvider } from "./registry.js";
import { isIP } from "node:net";
import { isPublicMcpAddress } from "./secure-fetch.js";

function isPrivateHost(hostname: string): boolean {
  // Strip the brackets IPv6 URLs carry: new URL("https://[::1]/").hostname is
  // "[::1]", and isIP() answers 0 for that, which reads as "not an IP" and
  // therefore "not private".
  //
  // MEASURED 2026-10-21 — this was a live SSRF bypass. The pattern here was
  // /^\\[|\\]$/g, which in source matches a BACKSLASH followed by a bracket,
  // not a bracket. So nothing was ever stripped and every IPv6 private address
  // passed the guard: https://[::1]/mcp, https://[fd00::1]/mcp and
  // https://[fe80::1]/mcp were all accepted as custom MCP servers, letting a
  // user point this backend at its own loopback. mcp-connection.test.ts caught
  // it and was failing on the branch.
  const host = hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    host === "metadata" || host === "metadata.google.internal" || host === "metadata.azure.internal") return true;
  return isIP(host) ? !isPublicMcpAddress(host) : false;
}
function safeRemoteUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || isPrivateHost(url.hostname) ||
      url.pathname.startsWith("/latest/meta-data") || url.pathname.startsWith("/computeMetadata/v1")) return null;
    return url;
  } catch {
    return null;
  }
}

export type McpAuth = {
  url: string;
  headers: Record<string, string>;
};

/** Resolve the exact endpoint and headers used by both discovery and calls. */
export function resolveMcpAuth(
  provider: Pick<McpProvider, "mcpServerUrl" | "authType" | "authHeader" | "credentialFields">,
  creds: Record<string, string>,
): McpAuth | null {
  const rawUrl = typeof provider.mcpServerUrl === "function"
    ? provider.mcpServerUrl(creds)
    : provider.mcpServerUrl;
  if (!rawUrl) return null;

  const url = safeRemoteUrl(rawUrl);
  if (!url) return null;

  const headers: Record<string, string> = {};
  if (provider.authType === "mcp_url") return { url: url.toString(), headers };
  if (provider.authType === "none") return { url: url.toString(), headers };
  if (provider.authType === "oauth") {
    const token = creds["oauth_access_token"] ?? creds["access_token"];
    if (token) headers.Authorization = `Bearer ${token}`;
    return { url: url.toString(), headers };
  }

  const credentialKey = provider.credentialFields?.find((field) => field.type === "password")?.key;
  const token = credentialKey ? creds[credentialKey] : undefined;
  if (!token) return null;

  if (provider.authType === "api_key") {
    headers[provider.authHeader ?? "Authorization"] = provider.authHeader
      ? token
      : `Bearer ${token}`;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }
  return { url: url.toString(), headers };
}

export function resolveCustomMcpAuth(input: {
  url: string;
  authType?: string | undefined;
  token?: string | undefined;
  headerName?: string | undefined;
}): McpAuth | null {
  try {
    const url = safeRemoteUrl(input.url);
    if (!url) return null;
    const headers: Record<string, string> = {};
    if (input.authType === "bearer_token" && input.token) headers.Authorization = `Bearer ${input.token}`;
    if (input.authType === "api_key") {
      if (!input.token || !input.headerName || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(input.headerName)) return null;
      headers[input.headerName] = input.token;
    }
    return { url: url.toString(), headers };
  } catch {
    return null;
  }
}

