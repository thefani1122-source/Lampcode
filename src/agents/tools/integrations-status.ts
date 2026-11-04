import type { ToolHandler } from "./registry.js";
import { INTERNAL_MCP_PROVIDERS, MCP_REGISTRY } from "../../mcp/registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * The one tool that answers "which services / tools are connected".
 *
 * Before this existed the model improvised: it listed exactly the providers its
 * prompt happened to name, marked every OAuth provider "not connected", and
 * fabricated a per-tool status table — while Vercel, Linear, Notion, Railway,
 * Cloudflare and Sentry sat connected in user_mcp_connections. This handler
 * reads the connectedServices summary build.ts resolves and reports it
 * verbatim. No invented statuses, ever.
 */

/** Slugs whose data the agent can inspect through a dedicated local query tool. */
const QUERY_TOOL_BY_SLUG: Record<string, string> = {
  github: "github_query",
  vercel: "vercel_query",
  shopify: "shopify_query",
  wordpress: "wordpress_query",
  twilio: "twilio_query",
  sendgrid: "sendgrid_query",
  mailchimp: "mailchimp_query",
};

export const integrationsStatusHandler: ToolHandler = async (
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> => {
  const services = ctx.connectedServices;
  if (!services) {
    return (
      "No connection summary was attached to this session, so I cannot report which services " +
      "are connected. That is a backend wiring gap, not an answer — retry the question once, " +
      "and if it still happens the integrations_status tool was not wired into this dispatch."
    );
  }
  if (services.length === 0) {
    return (
      "No services are connected right now. Connect one in the Integrations panel — GitHub, " +
      "Vercel, Linear, Notion, Railway, Cloudflare, Sentry, Figma, Shopify, WordPress, Twilio, " +
      "SendGrid, Mailchimp and more are available."
    );
  }

  const lines: string[] = ["Connected services right now:"];
  for (const s of services) {
    const auth = s.authType === "oauth" ? "OAuth" : s.authType;
    let line = `- ${s.name} (${s.slug}) — connected, auth: ${auth} (${s.source === "legacy" ? "legacy integrations store" : "MCP connection"})`;
    if (s.slug === "vercel") {
      line += s.restToken
        ? "; an account token is available, so queries, deployments and writes work"
        : "; BUT no account token could be resolved from it — reconnect Vercel so queries, deployments and writes work";
    }
    const queryTool = QUERY_TOOL_BY_SLUG[s.slug];
    if (queryTool) line += `; inspect it with ${queryTool}`;
    lines.push(line);
  }

  // Everything else the catalogue knows about, so the model never has to guess
  // what is missing. Internal platform servers (Firecrawl, Exa) are not user
  // connections and are excluded.
  const connected = new Set(services.map((s) => s.slug));
  const notConnected = Object.entries(MCP_REGISTRY)
    .filter(([slug]) => !connected.has(slug))
    .map(([, p]) => p.name);
  if (notConnected.length > 0) {
    lines.push(`Not connected (available in the Integrations panel): ${notConnected.join(", ")}.`);
  }

  lines.push(
    "OAuth services' read tools ride along automatically whenever a request mentions them; " +
    "every write or destructive action asks the user first.",
  );
  return lines.join("\n");
};
