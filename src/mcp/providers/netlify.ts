import { z } from "zod";
import { fetchJson, type ProviderDef } from "./_shared.js";

// ── Netlify (REST API + personal access token) ───────────────────────────────
// Netlify's remote MCP server speaks OAuth 2.1 (DCR + PKCE), but the store
// ships the REST path first: a personal access token is verifiable before
// storage and covers the read surface the agent needs (sites, deploys, logs).

export const netlifySchema = z.object({
  api_token: z.string().min(1, "Netlify personal access token is required"),
});
export type NetlifyParams = z.infer<typeof netlifySchema>;

const NETLIFY_API = "https://api.netlify.com/api/v1";

function authed(p: NetlifyParams, path: string): { url: string; init: RequestInit } {
  return {
    url: `${NETLIFY_API}${path}`,
    init: { headers: { Authorization: `Bearer ${p.api_token}`, Accept: "application/json" } },
  };
}

export async function netlifyUser(p: NetlifyParams): Promise<unknown> {
  const { url, init } = authed(p, "/user");
  return fetchJson(url, init);
}

export async function netlifySites(p: NetlifyParams): Promise<unknown> {
  const { url, init } = authed(p, "/sites?per_page=20");
  return fetchJson(url, init);
}

export async function netlifyDeploys(p: NetlifyParams, siteId: string): Promise<unknown> {
  const { url, init } = authed(p, `/sites/${encodeURIComponent(siteId)}/deploys?per_page=10`);
  return fetchJson(url, init);
}

export async function netlifyDeploy(p: NetlifyParams, deployId: string): Promise<unknown> {
  const { url, init } = authed(p, `/deploys/${encodeURIComponent(deployId)}`);
  return fetchJson(url, init);
}

export const netlify: ProviderDef = {
  id: "netlify",
  name: "Netlify",
  category: "Deploy",
  emoji: "🌐",
  description: "Inspect Netlify sites, deploys, and deploy logs via the Netlify REST API.",
  schema: netlifySchema,
  fields: [
    {
      key: "api_token",
      label: "Netlify Personal Access Token",
      type: "password",
      placeholder: "nfp_...",
      help: "Netlify → User settings → Applications → Personal access tokens",
    },
  ],
  testConnection: async (params) => {
    try {
      await netlifyUser(params as NetlifyParams);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  keywords: /\bnetlify\b/i,
  promptRule:
    "The user has connected Netlify with a personal access token. To inspect their sites and deploys, call the netlify_query tool (actions: list_sites, list_deploys with site_id, get_deploy with deploy_id). Deploy actions that create or publish go through the write gate — do not claim a deploy happened unless the tool confirmed it. Never embed the token in code.",
};

export default netlify;
