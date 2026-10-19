import type { McpProvider } from "./registry.js";

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

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;

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
    const url = new URL(input.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    const headers: Record<string, string> = {};
    if (input.authType === "bearer_token" && input.token) headers.Authorization = `Bearer ${input.token}`;
    if (input.authType === "api_key" && input.token && input.headerName) headers[input.headerName] = input.token;
    return { url: url.toString(), headers };
  } catch {
    return null;
  }
}

