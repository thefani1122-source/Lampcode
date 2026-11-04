import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

/**
 * Read-only REST lookups for credential-based providers — the same role
 * github_query and vercel_query play for token-based ones. Every handler
 * speaks for itself when the service is not connected, the same way
 * github-query.ts does, and none of them performs a write: writes on these
 * services stay behind request_write_action by design.
 */

export type Creds = Record<string, string>;

export type ServiceCredentials = Record<string, Creds | undefined>;

export function credsFor(ctx: ToolExecutionContext, slug: string): Creds | null {
  const creds = ctx.serviceCredentials?.[slug];
  if (!creds || Object.keys(creds).length === 0) return null;
  return creds;
}

export function notConnected(name: string, how: string): string {
  return (
    `${name} is not connected or has no usable credentials stored. ` +
    `Please tell the user to connect ${name} in the Integrations store ${how}.`
  );
}

export function missing(name: string, key: string, how: string): string {
  return (
    `The connected ${name} integration is missing its ${key}, so this lookup cannot run. ` +
    `Please tell the user to reconnect ${name} ${how}.`
  );
}

/** Shared GET that never throws — every caller formats the outcome itself. */
async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown; text: string }> {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text) as unknown; } catch { /* keep raw text */ }
    return { status: res.status, body, text };
  } catch (err) {
    return { status: 0, body: null, text: err instanceof Error ? err.message : String(err) };
  }
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
}

export function mailchimpDc(apiKey: string): string | null {
  const dc = apiKey.trim().split("-").pop() ?? "";
  return /^[a-z]{2,4}\d+$/.test(dc) ? dc : null;
}

export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

export function truncate(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// ── Shopify ──────────────────────────────────────────────────────────────────

export const shopifyQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "shopify");
  if (!creds) return notConnected("Shopify", "(Shop domain plus an Admin API access token).");
  const token = creds["adminApiAccessToken"]?.trim();
  if (!token) return missing("Shopify", "Admin API access token", "and add the Admin API token");
  const domain = normalizeBaseUrl(creds["shopDomain"] ?? "");
  if (!domain.endsWith("myshopify.com")) return missing("Shopify", "shop domain", "and check the shop domain");

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_products";
  const headers = { "X-Shopify-Access-Token": token, Accept: "application/json" };
  const base = `https://${domain}/admin/api/2026-01`;

  if (action === "list_products" || !action) {
    const { status, body } = await getJson(`${base}/products.json?limit=10`, headers);
    if (status !== 200) return `Shopify API error (${status}): ${truncate(body)}`;
    const products = (body as { products?: Array<Record<string, unknown>> }).products ?? [];
    if (products.length === 0) return "No products found in this Shopify store.";
    const lines = products.map((p) => {
      const variants = Array.isArray(p["variants"]) ? p["variants"] as Array<Record<string, unknown>> : [];
      const price = variants[0]?.["price"];
      return `- **${p["title"]}** (${p["status"] ?? "?"}, handle: ${p["handle"]}${price ? `, from $${price}` : ""})`;
    });
    return `Products in this Shopify store:\n${lines.join("\n")}`;
  }
  if (action === "get_product") {
    const id = String(args["id"] ?? "").trim();
    if (!id) return "Error: a product `id` (or use list_products first) is required.";
    const { status, body } = await getJson(`${base}/products/${encodeURIComponent(id)}.json`, headers);
    if (status !== 200) return `Shopify API error (${status}): ${truncate(body)}`;
    const p = (body as { product?: Record<string, unknown> }).product;
    if (!p) return `No product found with id ${id}.`;
    const variants = Array.isArray(p["variants"]) ? p["variants"] as Array<Record<string, unknown>> : [];
    return (
      `Product: **${p["title"]}**\n` +
      `- Status: ${p["status"]}, handle: ${p["handle"]}\n` +
      `- Variants: ${variants.map((v) => `${v["title"]} ($${v["price"]})`).join(", ") || "none"}\n` +
      `- Body: ${truncate(p["body_html"], 200)}`
    );
  }
  if (action === "list_orders") {
    const { status, body } = await getJson(`${base}/orders.json?status=any&limit=10`, headers);
    if (status !== 200) return `Shopify API error (${status}): ${truncate(body)}`;
    const orders = (body as { orders?: Array<Record<string, unknown>> }).orders ?? [];
    if (orders.length === 0) return "No orders found in this Shopify store.";
    const lines = orders.map((o) =>
      `- #${o["order_number"] ?? o["name"]} — ${o["financial_status"] ?? "?"}/${o["fulfillment_status"] ?? "unfulfilled"}, total $${o["total_price"]}`,
    );
    return `Recent Shopify orders:\n${lines.join("\n")}`;
  }
  return `Unknown action "${action}". Supported actions: list_products, get_product, list_orders.`;
};

// ── WordPress ────────────────────────────────────────────────────────────────

export const wordpressQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "wordpress");
  if (!creds) return notConnected("WordPress", "(Site URL, username, and an application password).");
  const site = creds["siteUrl"]?.trim();
  const user = creds["username"]?.trim();
  const pass = creds["appPassword"]?.replace(/\s+/g, "");
  if (!site || !user || !pass) return missing("WordPress", "site URL, username, or application password", "with all three fields");
  const base = `https://${normalizeBaseUrl(site)}/wp-json/wp/v2`;
  const headers = { Authorization: basic(user, pass), Accept: "application/json" };

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_posts";
  const fmt = (posts: Array<Record<string, unknown>>) =>
    posts.map((p) => `- [#${p["id"]}] **${p["title"] && (p["title"] as Record<string, unknown>)["rendered"]}** (${p["status"]}, ${p["date"] ?? "?"})`).join("\n");

  if (action === "list_posts" || !action) {
    const { status, body } = await getJson(`${base}/posts?per_page=10`, headers);
    if (status !== 200) return `WordPress API error (${status}): ${truncate(body)}`;
    const posts = body as Array<Record<string, unknown>>;
    if (!Array.isArray(posts) || posts.length === 0) return "No posts found on this WordPress site.";
    return `Recent WordPress posts:\n${fmt(posts)}`;
  }
  if (action === "list_pages") {
    const { status, body } = await getJson(`${base}/pages?per_page=10`, headers);
    if (status !== 200) return `WordPress API error (${status}): ${truncate(body)}`;
    const pages = body as Array<Record<string, unknown>>;
    if (!Array.isArray(pages) || pages.length === 0) return "No pages found on this WordPress site.";
    return `WordPress pages:\n${fmt(pages)}`;
  }
  if (action === "get_post") {
    const id = String(args["id"] ?? "").trim();
    if (!id) return "Error: a post/page `id` (from list_posts or list_pages) is required.";
    const { status, body } = await getJson(`${base}/posts/${encodeURIComponent(id)}`, headers);
    if (status !== 200) return `WordPress API error (${status}): ${truncate(body)}`;
    const p = body as Record<string, unknown>;
    return (
      `Post #${p["id"]}: **${p["title"] && (p["title"] as Record<string, unknown>)["rendered"]}**\n` +
      `- Status: ${p["status"]}, published: ${p["date"]}\n` +
      `- Link: ${p["link"]}\n` +
      `- Excerpt: ${truncate(p["excerpt"] && (p["excerpt"] as Record<string, unknown>)["rendered"], 200)}`
    );
  }
  return `Unknown action "${action}". Supported actions: list_posts, list_pages, get_post.`;
};

// ── Twilio ───────────────────────────────────────────────────────────────────

export const twilioQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "twilio");
  if (!creds) return notConnected("Twilio", "(Account SID and Auth Token).");
  const sid = creds["account_sid"]?.trim();
  const token = creds["auth_token"]?.trim();
  if (!sid || !token) return missing("Twilio", "Account SID or Auth Token", "with both values");
  const headers = { Authorization: basic(sid, token), Accept: "application/json" };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_messages";

  if (action === "list_messages" || !action) {
    const { status, body } = await getJson(`${base}/Messages.json?PageSize=10`, headers);
    if (status !== 200) return `Twilio API error (${status}): ${truncate(body)}`;
    const messages = (body as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    if (messages.length === 0) return "No messages found on this Twilio account.";
    const lines = messages.map((m) =>
      `- ${m["date_sent"] ?? "?"} ${m["from"]} → ${m["to"]} [${m["status"]}]: ${truncate(m["body"], 80)}`,
    );
    return `Recent Twilio messages:\n${lines.join("\n")}`;
  }
  if (action === "list_calls") {
    const { status, body } = await getJson(`${base}/Calls.json?PageSize=10`, headers);
    if (status !== 200) return `Twilio API error (${status}): ${truncate(body)}`;
    const calls = (body as { calls?: Array<Record<string, unknown>> }).calls ?? [];
    if (calls.length === 0) return "No calls found on this Twilio account.";
    const lines = calls.map((c) =>
      `- ${c["start_time"] ?? "?"} ${c["from"]} → ${c["to"]} [${c["status"]}], ${c["duration"] ?? "?"}s`,
    );
    return `Recent Twilio calls:\n${lines.join("\n")}`;
  }
  if (action === "get_message") {
    const id = String(args["id"] ?? "").trim();
    if (!id) return "Error: a message `sid` (from list_messages) is required.";
    const { status, body } = await getJson(`${base}/Messages/${encodeURIComponent(id)}.json`, headers);
    if (status !== 200) return `Twilio API error (${status}): ${truncate(body)}`;
    const m = body as Record<string, unknown>;
    return `Message ${m["sid"]}: ${m["from"]} → ${m["to"]} [${m["status"]}]\nBody: ${m["body"]}`;
  }
  return `Unknown action "${action}". Supported actions: list_messages, list_calls, get_message.`;
};

// ── SendGrid ─────────────────────────────────────────────────────────────────

export const sendgridQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "sendgrid");
  if (!creds) return notConnected("SendGrid", "(a SendGrid API key).");
  const key = creds["api_key"]?.trim();
  if (!key) return missing("SendGrid", "API key", "with a valid API key");
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_templates";

  if (action === "list_templates" || !action) {
    const { status, body } = await getJson("https://api.sendgrid.com/v3/templates?generations=dynamic&page_size=10", headers);
    if (status !== 200) return `SendGrid API error (${status}): ${truncate(body)}`;
    const templates = (body as { templates?: Array<Record<string, unknown>> }).templates ?? [];
    if (templates.length === 0) return "No email templates found on this SendGrid account.";
    const lines = templates.map((t) => `- **${t["name"]}** (${t["id"]}, generated: ${t["generation"]})`);
    return `SendGrid templates:\n${lines.join("\n")}`;
  }
  if (action === "list_contacts") {
    const { status, body } = await getJson("https://api.sendgrid.com/v3/marketing/contacts?page_size=10", headers);
    if (status !== 200) return `SendGrid API error (${status}): ${truncate(body)}`;
    const contacts = (body as { contacts?: Array<Record<string, unknown>> }).contacts ?? [];
    if (contacts.length === 0) return "No marketing contacts found on this SendGrid account.";
    const lines = contacts.slice(0, 10).map((c) => `- ${c["email"]} (created ${c["created_at"] ?? "?"})`);
    return `SendGrid marketing contacts (first 10):\n${lines.join("\n")}`;
  }
  if (action === "list_lists") {
    const { status, body } = await getJson("https://api.sendgrid.com/v3/marketing/lists?page_size=10", headers);
    if (status !== 200) return `SendGrid API error (${status}): ${truncate(body)}`;
    const lists = (body as { result?: Array<Record<string, unknown>> }).result ?? [];
    if (lists.length === 0) return "No contact lists found on this SendGrid account.";
    const lines = lists.map((l) => `- **${l["name"]}** (${l["id"]}, ${l["contact_count"] ?? 0} contacts)`);
    return `SendGrid contact lists:\n${lines.join("\n")}`;
  }
  return `Unknown action "${action}". Supported actions: list_templates, list_contacts, list_lists.`;
};

// ── Mailchimp ────────────────────────────────────────────────────────────────

export const mailchimpQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "mailchimp");
  if (!creds) return notConnected("Mailchimp", "(a Mailchimp API key).");
  const key = creds["api_key"]?.trim();
  if (!key) return missing("Mailchimp", "API key", "with a valid API key");
  const dc = mailchimpDc(key);
  if (!dc) return missing("Mailchimp", "datacenter suffix in the API key", "with a full API key like xxxxxxxx-us1");
  const headers = { Authorization: basic("lampcode", key), Accept: "application/json" };
  const base = `https://${dc}.api.mailchimp.com/3.0`;

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_campaigns";

  if (action === "list_campaigns" || !action) {
    const { status, body } = await getJson(`${base}/campaigns?count=10`, headers);
    if (status !== 200) return `Mailchimp API error (${status}): ${truncate(body)}`;
    const campaigns = (body as { campaigns?: Array<Record<string, unknown>> }).campaigns ?? [];
    if (campaigns.length === 0) return "No campaigns found on this Mailchimp account.";
    const lines = campaigns.map((c) =>
      `- **${c["settings"] && (c["settings"] as Record<string, unknown>)["subject_line"]}** (${c["status"]}, ${c["type"]}, sent: ${c["send_time"] ?? "not sent"})`,
    );
    return `Mailchimp campaigns:\n${lines.join("\n")}`;
  }
  if (action === "get_lists") {
    const { status, body } = await getJson(`${base}/lists?count=10`, headers);
    if (status !== 200) return `Mailchimp API error (${status}): ${truncate(body)}`;
    const lists = (body as { lists?: Array<Record<string, unknown>> }).lists ?? [];
    if (lists.length === 0) return "No audiences found on this Mailchimp account.";
    const lines = lists.map((l) => `- **${l["name"]}** (${l["id"]}, ${l["stats"] && (l["stats"] as Record<string, unknown>)["member_count"]} members)`);
    return `Mailchimp audiences:\n${lines.join("\n")}`;
  }
  if (action === "list_members") {
    const listId = String(args["list_id"] ?? "").trim();
    if (!listId) return "Error: a `list_id` (from get_lists) is required.";
    const { status, body } = await getJson(`${base}/lists/${encodeURIComponent(listId)}/members?count=10`, headers);
    if (status !== 200) return `Mailchimp API error (${status}): ${truncate(body)}`;
    const members = (body as { members?: Array<Record<string, unknown>> }).members ?? [];
    if (members.length === 0) return "No members found in this audience.";
    const lines = members.map((m) => `- ${m["email_address"]} (${m["status"]})`);
    return `Audience members (first 10):\n${lines.join("\n")}`;
  }
  return `Unknown action "${action}". Supported actions: list_campaigns, get_lists, list_members.`;
};

// ── Figma ────────────────────────────────────────────────────────────────────
// mcp.figma.com only authorizes catalog-approved clients, so reads go through
// the documented REST API with the stored personal access token.

export const figmaQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "figma");
  if (!creds) return notConnected("Figma", "(a Figma Personal Access Token).");
  const token = creds["figma_pat"]?.trim() ?? creds["figma_access_token"]?.trim();
  if (!token) return missing("Figma", "personal access token", "and add the token");
  const headers = { "X-Figma-Token": token, Accept: "application/json" };

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "get_file";

  if (action === "get_me") {
    const { status, body } = await getJson("https://api.figma.com/v1/me", headers);
    if (status !== 200) return `Figma API error (${status}): ${truncate(body)}`;
    const me = body as { handle?: string; email?: string };
    return `Figma account: **${me.handle ?? "?"}** (${me.email ?? "no email"}) — token works.`;
  }
  if (action === "list_team_projects") {
    const teamId = String(args["team_id"] ?? "").trim();
    if (!teamId) return "Error: a `team_id` is required (from a team URL: figma.com/files/team/<team_id>/...).";
    const { status, body } = await getJson(`https://api.figma.com/v1/teams/${encodeURIComponent(teamId)}/projects`, headers);
    if (status !== 200) return `Figma API error (${status}): ${truncate(body)}`;
    const projects = (body as { projects?: Array<{ id?: string; name?: string }> }).projects ?? [];
    if (projects.length === 0) return "No projects found for this Figma team.";
    const lines = projects.map((p) => `- **${p.name ?? "?"}** (id: ${p.id ?? "?"})`);
    return `Figma projects in this team:\n${lines.join("\n")}`;
  }
  if (action === "get_file" || action === "list_file_components") {
    const fileKey = String(args["file_key"] ?? "").trim();
    if (!fileKey) {
      return (
        "Error: a `file_key` is required — it is the part of a Figma URL after /design/ or /file/ " +
        "(e.g. figma.com/design/AbCdEf123/Name → AbCdEf123). Ask the user for the Figma link if needed."
      );
    }
    if (action === "list_file_components") {
      const { status, body } = await getJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/components`, headers);
      if (status !== 200) return `Figma API error (${status}): ${truncate(body)}`;
      const comps = (body as { meta?: { components?: Array<{ node_id?: string; name?: string; description?: string }> } }).meta?.components ?? [];
      if (comps.length === 0) return "No published components in this Figma file.";
      const lines = comps.slice(0, 30).map((c) => `- **${c.name ?? "?"}** (node: ${c.node_id ?? "?"})${c.description ? ` — ${truncate(c.description, 80)}` : ""}`);
      return `Components in this Figma file:\n${lines.join("\n")}`;
    }
    const { status, body } = await getJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?depth=2`, headers);
    if (status !== 200) return `Figma API error (${status}): ${truncate(body)}`;
    const file = body as { name?: string; lastModified?: string; document?: { children?: Array<{ name?: string }> }, components?: Record<string, unknown> };
    const pages = file.document?.children?.map((c) => c.name ?? "?") ?? [];
    return (
      `Figma file **${file.name ?? fileKey}**\n` +
      `- Last modified: ${file.lastModified ?? "?"}\n` +
      `- Pages: ${pages.join(", ") || "none"}\n` +
      `- Published components: ${Object.keys(file.components ?? {}).length}\n` +
      `Use list_file_components for component details or get_image_urls to export specific nodes.`
    );
  }
  if (action === "get_image_urls") {
    const fileKey = String(args["file_key"] ?? "").trim();
    const nodeIds = String(args["node_ids"] ?? "").trim();
    if (!fileKey || !nodeIds) return "Error: `file_key` and `node_ids` (comma-separated) are required.";
    const { status, body } = await getJson(
      `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeIds)}`,
      headers,
    );
    if (status !== 200) return `Figma API error (${status}): ${truncate(body)}`;
    const images = (body as { images?: Record<string, string | null> }).images ?? {};
    const entries = Object.entries(images);
    if (entries.length === 0) return "Figma returned no rendered images for these nodes.";
    const lines = entries.map(([id, url]) => `- ${id}: ${url ?? "not rendered yet (retry in a few seconds)"}`);
    return `Rendered images:\n${lines.join("\n")}`;
  }
  return `Unknown action "${action}". Supported actions: get_me, list_team_projects, get_file, list_file_components, get_image_urls.`;
};

// ── Netlify ──────────────────────────────────────────────────────────────────
// Netlify's remote MCP speaks OAuth 2.1; the store ships the REST path with a
// personal access token because it is verifiable before storage. Reads only —
// creating or publishing deploys stays behind the write gate.

export const netlifyQueryHandler: ToolHandler = async (args, ctx) => {
  const creds = credsFor(ctx, "netlify");
  if (!creds) return notConnected("Netlify", "(a Netlify Personal Access Token).");
  const token = creds["api_token"]?.trim() ?? creds["netlify_auth_token"]?.trim();
  if (!token) return missing("Netlify", "personal access token", "and add the token");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  const action = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "list_sites";

  if (action === "list_sites" || !action) {
    const { status, body } = await getJson("https://api.netlify.com/api/v1/sites?per_page=20", headers);
    if (status !== 200) return `Netlify API error (${status}): ${truncate(body)}`;
    const sites = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    if (sites.length === 0) return "No sites found in this Netlify account.";
    const lines = sites.map((s) => {
      const ssl = typeof s["ssl_url"] === "string" ? s["ssl_url"] : typeof s["url"] === "string" ? s["url"] : "";
      const updated = typeof s["updated_at"] === "string" ? s["updated_at"].slice(0, 10) : "";
      return `- **${s["name"]}** (${ssl}) — id: ${s["id"]}${updated ? `, updated ${updated}` : ""}`;
    });
    return `Netlify sites:\n${lines.join("\n")}`;
  }
  if (action === "list_deploys") {
    const siteId = String(args["site_id"] ?? "").trim();
    if (!siteId) return "Error: a `site_id` is required (use list_sites first).";
    const { status, body } = await getJson(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=10`, headers);
    if (status !== 200) return `Netlify API error (${status}): ${truncate(body)}`;
    const deploys = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    if (deploys.length === 0) return "No deploys found for this Netlify site.";
    const lines = deploys.map((d) =>
      `- ${d["state"] ?? "?"} — ${d["created_at"] ?? "?"} (id: ${d["id"]}${d["title"] ? `, ${d["title"]}` : ""})`,
    );
    return `Recent deploys for this site:\n${lines.join("\n")}`;
  }
  if (action === "get_deploy") {
    const deployId = String(args["deploy_id"] ?? "").trim();
    if (!deployId) return "Error: a `deploy_id` is required (use list_deploys first).";
    const { status, body } = await getJson(`https://api.netlify.com/api/v1/deploys/${encodeURIComponent(deployId)}`, headers);
    if (status !== 200) return `Netlify API error (${status}): ${truncate(body)}`;
    const d = body as Record<string, unknown>;
    return (
      `Deploy **${d["id"]}**\n` +
      `- State: ${d["state"]}, created: ${d["created_at"] ?? "?"}\n` +
      `- URL: ${d["ssl_url"] ?? d["url"] ?? "?"}\n` +
      `- Commit: ${d["commit_ref"] ?? "n/a"}${d["title"] ? ` (${d["title"]})` : ""}\n` +
      `- Publishable when state is "ready"; failed deploys report ${truncate(d["error_message"] ?? "no error message", 200)}`
    );
  }
  return `Unknown action "${action}". Supported actions: list_sites, list_deploys, get_deploy.`;
};
