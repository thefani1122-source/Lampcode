import type { ToolDefinition } from "./../model-gateway.js";
import type { ToolExecutionContext } from "../tools.js";
import type { WriteMcpMeta } from "../mcp-tool-classifier.js";
import type { Tier } from "../../mcp/tiers.js";
import { credsFor, notConnected, missing, basic, truncate } from "./rest-queries.js";

/**
 * Write tools for credential-based REST providers — the counterpart of the
 * read-only tools in rest-queries.ts. These are never registered in the static
 * handler registry: the ONLY path to them runs through the shared write
 * approval gate (build:write_action_approval_required) in executeTool, so a
 * user always sees and approves what will happen before it happens.
 *
 * Tiers: reversible creates/updates are "approval"; anything that leaves the
 * user's account and can't be undone (a sent SMS, a sent email) is
 * "strong-approval".
 */

type Creds = Record<string, string>;

async function sendJson(
  url: string,
  method: "POST" | "PUT" | "PATCH",
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text) as unknown; } catch { /* keep raw text */ }
    return { status: res.status, body, text };
  } catch (err) {
    return { status: 0, body: null, text: err instanceof Error ? err.message : String(err) };
  }
}

async function sendForm(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
): Promise<{ status: number; body: unknown; text: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields).toString(),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text) as unknown; } catch { /* keep raw text */ }
    return { status: res.status, body, text };
  } catch (err) {
    return { status: 0, body: null, text: err instanceof Error ? err.message : String(err) };
  }
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

// ── Shopify ──────────────────────────────────────────────────────────────────

export const shopifyWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const creds = credsFor(ctx, "shopify");
  if (!creds) return notConnected("Shopify", "(Shop domain plus an Admin API access token).");
  const token = creds["adminApiAccessToken"]?.trim();
  if (!token) return missing("Shopify", "Admin API access token", "and add the Admin API token");
  const domain = creds["shopDomain"]?.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  if (!domain || !domain.endsWith("myshopify.com")) return missing("Shopify", "shop domain", "and check the shop domain");
  const base = `https://${domain}/admin/api/2026-01`;
  const headers = { "X-Shopify-Access-Token": token };

  const action = str(args, "action") || "create_product";

  if (action === "create_product") {
    const title = str(args, "title");
    if (!title) return "Error: a `title` is required to create a product.";
    const status = str(args, "status") === "active" ? "active" : "draft";
    const price = str(args, "price");
    const product: Record<string, unknown> = { title, status };
    if (str(args, "bodyHtml")) product["body_html"] = str(args, "bodyHtml");
    if (price) product["variants"] = [{ price }];
    const { status: code, body } = await sendJson(`${base}/products.json`, "POST", headers, { product });
    if (code !== 201) return `Shopify API error (${code}): ${truncate(body)}`;
    const created = (body as { product?: Record<string, unknown> }).product;
    return `Created Shopify product **${created?.["title"]}** (status: ${created?.["status"]}, id: ${created?.["id"]}).` +
      (created?.["status"] === "draft" ? " It is a draft — the user can publish it in Shopify when ready." : "");
  }

  if (action === "update_product") {
    const id = str(args, "id");
    if (!id) return "Error: a product `id` (from shopify_query) is required to update a product.";
    const patch: Record<string, unknown> = {};
    if (str(args, "title")) patch["title"] = str(args, "title");
    if (str(args, "bodyHtml")) patch["body_html"] = str(args, "bodyHtml");
    if (["draft", "active"].includes(str(args, "status"))) patch["status"] = str(args, "status");
    if (Object.keys(patch).length === 0) return "Error: nothing to update — pass a `title`, `body_html`, or `status`.";
    const { status: code, body } = await sendJson(`${base}/products/${encodeURIComponent(id)}.json`, "PUT", headers, { product: patch });
    if (code !== 200) return `Shopify API error (${code}): ${truncate(body)}`;
    const updated = (body as { product?: Record<string, unknown> }).product;
    return `Updated Shopify product **${updated?.["title"]}** (id: ${updated?.["id"]}, status: ${updated?.["status"]}).`;
  }

  return 'Unknown action. Supported actions: "create_product", "update_product".';
};

// ── WordPress ────────────────────────────────────────────────────────────────

export const wordpressWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const creds = credsFor(ctx, "wordpress");
  if (!creds) return notConnected("WordPress", "(Site URL, username, and an application password).");
  const site = creds["siteUrl"]?.trim();
  const user = creds["username"]?.trim();
  const pass = creds["appPassword"]?.replace(/\s+/g, "");
  if (!site || !user || !pass) return missing("WordPress", "site URL, username, or application password", "with all three fields");
  const base = `https://${site.replace(/\/+$/, "").replace(/^https?:\/\//, "")}/wp-json/wp/v2`;
  const headers = { Authorization: basic(user, pass) };

  const action = str(args, "action") || "create_post";

  if (action === "create_post") {
    const title = str(args, "title");
    if (!title) return "Error: a `title` is required to create a post.";
    const status = ["draft", "publish"].includes(str(args, "status")) ? str(args, "status") : "draft";
    const { status: code, body } = await sendJson(`${base}/posts`, "POST", headers, {
      title,
      content: str(args, "content"),
      status,
    });
    if (code !== 201) return `WordPress API error (${code}): ${truncate(body)}`;
    const created = body as Record<string, unknown>;
    const link = created["link"] ? `\n- Link: ${created["link"]}` : "";
    return `Created WordPress post **${title}** (id: ${created["id"]}, status: ${created["status"]}).${link}` +
      (status === "draft" ? " It is a draft — the user can publish it in WordPress when ready." : "");
  }

  if (action === "update_post") {
    const id = str(args, "id");
    if (!id) return "Error: a post `id` (from wordpress_query) is required to update a post.";
    const patch: Record<string, unknown> = {};
    if (str(args, "title")) patch["title"] = str(args, "title");
    if (str(args, "content")) patch["content"] = str(args, "content");
    if (["draft", "publish"].includes(str(args, "status"))) patch["status"] = str(args, "status");
    if (Object.keys(patch).length === 0) return "Error: nothing to update — pass a `title`, `content`, or `status`.";
    const { status: code, body } = await sendJson(`${base}/posts/${encodeURIComponent(id)}`, "POST", headers, patch);
    if (code !== 200) return `WordPress API error (${code}): ${truncate(body)}`;
    const updated = body as Record<string, unknown>;
    return `Updated WordPress post #${updated["id"]} (status: ${updated["status"]}).`;
  }

  return 'Unknown action. Supported actions: "create_post", "update_post".';
};

// ── Twilio ───────────────────────────────────────────────────────────────────

export const twilioWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const creds = credsFor(ctx, "twilio");
  if (!creds) return notConnected("Twilio", "(Account SID and Auth Token).");
  const sid = creds["account_sid"]?.trim();
  const token = creds["auth_token"]?.trim();
  if (!sid || !token) return missing("Twilio", "Account SID or Auth Token", "with both values");
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
  const headers = { Authorization: basic(sid, token), Accept: "application/json" };

  const action = str(args, "action") || "send_sms";
  if (action !== "send_sms") return 'Unknown action. Supported action: "send_sms".';

  const to = str(args, "to");
  const from = str(args, "from");
  const body = str(args, "body");
  if (!to || !from || !body) return "Error: `to`, `from`, and `body` are all required to send an SMS.";
  const result = await sendForm(`${base}/Messages.json`, headers, { To: to, From: from, Body: body });
  if (result.status !== 200 && result.status !== 201)
    return `Twilio API error (${result.status}): ${truncate(result.body)}`;
  const message = (result.body as Record<string, unknown>) ?? {};
  return `SMS sent: ${message["from"]} → ${message["to"]} (status: ${message["status"]}, sid: ${message["sid"]}).`;
};

// ── SendGrid ─────────────────────────────────────────────────────────────────

export const sendgridWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const creds = credsFor(ctx, "sendgrid");
  if (!creds) return notConnected("SendGrid", "(API key).");
  const key = creds["api_key"]?.trim();
  if (!key) return missing("SendGrid", "API key", "with a valid key");
  const base = "https://api.sendgrid.com/v3";
  const headers = { Authorization: `Bearer ${key}` };

  const action = str(args, "action") || "send_email";

  if (action === "send_email") {
    const to = str(args, "to");
    const subject = str(args, "subject");
    const text = str(args, "text");
    const html = str(args, "html");
    if (!to || !subject || (!text && !html))
      return "Error: `to`, `subject`, and either `text` or `html` are required to send an email.";
    const { status, body } = await sendJson(`${base}/mail/send`, "POST", headers, {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: creds["fromEmail"]?.trim() || to, name: creds["fromName"]?.trim() || undefined },
      subject,
      content: [{ type: html ? "text/html" : "text/plain", value: html || text }],
    });
    if (status !== 202) return `SendGrid API error (${status}): ${truncate(body)}`;
    return `Email sent to ${to} with subject "${subject}". SendGrid queued it (202).`;
  }

  if (action === "add_contact") {
    const email = str(args, "email");
    if (!email) return "Error: an `email` is required to add a contact.";
    const contact: Record<string, unknown> = { email };
    if (str(args, "firstName")) contact["first_name"] = str(args, "firstName");
    if (str(args, "lastName")) contact["last_name"] = str(args, "lastName");
    const { status, body } = await sendJson(`${base}/marketing/contacts`, "PUT", headers, {
      contacts: [contact],
    });
    if (status !== 200 && status !== 201 && status !== 202)
      return `SendGrid API error (${status}): ${truncate(body)}`;
    return `SendGrid accepted the contact ${email} (it may take a moment to appear in Marketing Contacts).`;
  }

  return 'Unknown action. Supported actions: "send_email", "add_contact".';
};

// ── Mailchimp ────────────────────────────────────────────────────────────────

export const mailchimpWriteHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const creds = credsFor(ctx, "mailchimp");
  if (!creds) return notConnected("Mailchimp", "(API key).");
  const key = creds["api_key"]?.trim();
  if (!key) return missing("Mailchimp", "API key", "with a valid key");
  const dc = key.split("-").pop() ?? "";
  if (!/^[a-z]{2,4}\d+$/.test(dc)) return missing("Mailchimp", "datacenter suffix", "with a full key like xxxxxxxx-us1");
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const headers = { Authorization: `Basic ${btoa(`anystring:${key}`)}` };

  const action = str(args, "action") || "add_member";

  if (action === "add_member") {
    const listId = str(args, "list_id");
    const email = str(args, "email");
    if (!listId || !email) return "Error: `list_id` (from mailchimp_query) and `email` are required.";
    // Status is always "pending": Mailchimp then emails the person a
    // confirmation link, so nobody is subscribed without their own opt-in.
    const { status, body } = await sendJson(`${base}/lists/${encodeURIComponent(listId)}/members`, "POST", headers, {
      email_address: email,
      status: "pending",
    });
    if (status !== 200 && status !== 201)
      return `Mailchimp API error (${status}): ${truncate(body)}`;
    const member = (body as Record<string, unknown>) ?? {};
    return `Added ${member["email_address"] ?? email} to the list as **pending** — Mailchimp will email them a confirmation link (double opt-in).`;
  }

  if (action === "create_campaign") {
    const listId = str(args, "list_id");
    if (!listId) return "Error: a `list_id` (from mailchimp_query) is required.";
    const subject = str(args, "subject") || "Untitled campaign";
    const created = await sendJson(`${base}/campaigns`, "POST", headers, {
      type: "regular",
      recipients: { list_id: listId },
      settings: { subject_line: subject },
    });
    if (created.status !== 200) return `Mailchimp API error (${created.status}): ${truncate(created.body)}`;
    const campaign = (created.body as Record<string, unknown>) ?? {};
    const id = String(campaign["id"] ?? "");
    if (str(args, "html") && id) {
      const content = await sendJson(`${base}/campaigns/${encodeURIComponent(id)}/content`, "PUT", headers, {
        html: str(args, "html"),
      });
      if (content.status !== 200) return `Campaign created but setting content failed (${content.status}): ${truncate(content.body)}`;
    }
    return `Created Mailchimp campaign **${subject}** (id: ${id}) as a draft. Nothing was sent — the user reviews and sends it from Mailchimp.`;
  }

  return 'Unknown action. Supported actions: "add_member", "create_campaign".';
};

// ── Definitions + approval-gate registry ────────────────────────────────────

const DEFINE = (name: string, provider: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  name,
  description,
  input_schema: {
    type: "object",
    properties,
    required,
  },
});

export const REST_WRITE_PROVIDER: Record<string, string> = {
  shopify_write: "shopify",
  wordpress_write: "wordpress",
  twilio_write: "twilio",
  sendgrid_write: "sendgrid",
  mailchimp_write: "mailchimp",
};

export const REST_WRITE_DEFS: ToolDefinition[] = [
  DEFINE(
    "shopify_write",
    "shopify",
    "Create or update a product in the user's connected Shopify store. This is a WRITE action: " +
      "the user is asked to approve it first. New products are created as drafts unless the user asked for 'active'.",
    {
      action: { type: "string", enum: ["create_product", "update_product"], description: "Default 'create_product'." },
      title: { type: "string", description: "Product title." },
      bodyHtml: { type: "string", description: "Product description (HTML), optional." },
      price: { type: "string", description: "Price for the first variant, e.g. '29.99'. Optional on create." },
      status: { type: "string", enum: ["draft", "active"], description: "Product status. Defaults to 'draft' on create." },
      id: { type: "string", description: "Product id — required for 'update_product' (use shopify_query to find it)." },
    },
    [],
  ),
  DEFINE(
    "wordpress_write",
    "wordpress",
    "Create or update a post on the user's connected WordPress site. This is a WRITE action: " +
      "the user is asked to approve it first. New posts are drafts unless the user explicitly asked to publish.",
    {
      action: { type: "string", enum: ["create_post", "update_post"], description: "Default 'create_post'." },
      title: { type: "string", description: "Post title." },
      content: { type: "string", description: "Post body (HTML)." },
      status: { type: "string", enum: ["draft", "publish"], description: "Defaults to 'draft' on create." },
      id: { type: "string", description: "Post id — required for 'update_post' (use wordpress_query to find it)." },
    },
    [],
  ),
  DEFINE(
    "twilio_write",
    "twilio",
    "Send an SMS from the user's connected Twilio account. This is a WRITE action that cannot be " +
      "undone and may cost money: it needs explicit user approval, and the user must have asked for it.",
    {
      action: { type: "string", enum: ["send_sms"] },
      to: { type: "string", description: "Destination phone number in E.164 format, e.g. '+15551234567'." },
      from: { type: "string", description: "A Twilio number or sender ID on the user's account. Use twilio_query if unsure." },
      body: { type: "string", description: "Message text." },
    },
    [],
  ),
  DEFINE(
    "sendgrid_write",
    "sendgrid",
    "Send an email or add a marketing contact via the user's connected SendGrid account. WRITE actions: " +
      "sending an email cannot be undone and needs explicit approval; adding a contact is reversible.",
    {
      action: { type: "string", enum: ["send_email", "add_contact"], description: "Default 'send_email'." },
      to: { type: "string", description: "Recipient email address ('send_email')." },
      subject: { type: "string", description: "Email subject ('send_email')." },
      text: { type: "string", description: "Plain-text body." },
      html: { type: "string", description: "HTML body (wins over `text` if both are set)." },
      email: { type: "string", description: "Contact email address ('add_contact')." },
      firstName: { type: "string", description: "Contact first name ('add_contact', optional)." },
      lastName: { type: "string", description: "Contact last name ('add_contact', optional)." },
    },
    [],
  ),
  DEFINE(
    "mailchimp_write",
    "mailchimp",
    "Add an audience member or create a draft campaign in the user's connected Mailchimp account. " +
      "WRITE actions: the user is asked to approve first. New members get 'pending' status (double opt-in, " +
      "Mailchimp emails them a confirmation link) and campaigns are ALWAYS drafts — this tool never sends.",
    {
      action: { type: "string", enum: ["add_member", "create_campaign"], description: "Default 'add_member'." },
      list_id: { type: "string", description: "Audience/list id (use mailchimp_query to find it)." },
      email: { type: "string", description: "Email address ('add_member')." },
      subject: { type: "string", description: "Campaign subject line ('create_campaign')." },
      html: { type: "string", description: "Campaign content as HTML ('create_campaign', optional)." },
    },
    [],
  ),
];

export function buildRestWriteRegistry(credentials?: Record<string, Record<string, string> | undefined>): Map<string, WriteMcpMeta> {
  const registry = new Map<string, WriteMcpMeta>();
  for (const def of REST_WRITE_DEFS) {
    const slug: string | undefined = REST_WRITE_PROVIDER[def.name];
    if (!slug) continue;
    const creds = credentials?.[slug];
    if (!creds || Object.keys(creds).length === 0) continue;
    registry.set(def.name, {
      serverSlug: slug,
      serverUrl: "",
      authToken: null,
      mcpToolName: def.name,
      tier: def.name === "twilio_write" ? "strong-approval" : "approval",
      capability: null,
      localExecute: async (args, ctx) => {
        switch (def.name) {
          case "shopify_write": return shopifyWriteHandler(args, ctx);
          case "wordpress_write": return wordpressWriteHandler(args, ctx);
          case "twilio_write": return twilioWriteHandler(args, ctx);
          case "sendgrid_write": return sendgridWriteHandler(args, ctx);
          case "mailchimp_write": return mailchimpWriteHandler(args, ctx);
          default: return `Error: unknown tool "${def.name}".`;
        }
      },
    });
  }
  return registry;
}
