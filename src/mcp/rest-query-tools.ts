/**
 * Safe, read-only tools for the catalogue's REST/API providers.
 *
 * No model-supplied URL is executed. Provider endpoints and auth come from this
 * module; model arguments are restricted to resource IDs and bounded page sizes.
 * Mutations are deliberately absent from this tool set.
 */
import type { ToolDefinition } from "../agents/model-gateway.js";
import { secureMcpFetch } from "./secure-fetch.js";
import type { RestConnection, RestProviderSlug } from "./rest-integrations.js";

export interface RestQueryProvider {
  slug: RestProviderSlug;
  name: string;
}
export interface RestQueryToolSet {
  tools: ToolDefinition[];
  executors: Map<string, (args: Record<string, unknown>) => Promise<string>>;
  providers: RestQueryProvider[];
}
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEPLOY = /\b(deployments?|deploys?|sites?|hosting|production|previews?|releases?)\b/i;
const DATABASE = /\b(database|databases|collections?|records?|documents?)\b/i;
const CONTENT = /\b(posts?|pages?|cms|content|products?|orders?|shopify|wordpress|catalog|e-?commerce|audiences?|subscribers?)\b/i;
const EMAIL = /\b(email|emails|domains?|campaigns?|audiences?|mailchimp|resend|sendgrid)\b/i;
const MESSAGING = /\b(messages?|sms|calls?|twilio|phone)\b/i;
const PROVIDER_ALIASES: Record<string, string[]> = {
  netlify: ["netlify"], railway: ["railway"], shopify: ["shopify"],
  wordpress: ["wordpress", "woocommerce", "wp"], mailchimp: ["mailchimp"],
  resend: ["resend"], twilio: ["twilio"], sendgrid: ["sendgrid"],

};

function explicitProvider(prompt: string, slug: string): boolean {
  return (PROVIDER_ALIASES[slug] ?? [slug]).some((name) =>
    new RegExp("(^|[^a-z0-9])" + name + "($|[^a-z0-9])", "i").test(prompt),
  );
}

function categoryFor(slug: string): "deploy" | "content" | "email" | "messaging" | "database" | null {
  if (["netlify", "railway"].includes(slug)) return "deploy";
  if (["wordpress", "shopify"].includes(slug)) return "content";
  if (["mailchimp", "resend", "sendgrid"].includes(slug)) return "email";
  if (slug === "twilio") return "messaging";
  return null;
}
function categoryHint(category: ReturnType<typeof categoryFor>, prompt: string): boolean {
  switch (category) {
    case "deploy": return DEPLOY.test(prompt);
    case "content": return CONTENT.test(prompt);
    case "email": return EMAIL.test(prompt);
    case "messaging": return MESSAGING.test(prompt);
    case "database": return DATABASE.test(prompt);
    default: return false;
  }
}

/** Explicit provider mentions suppress category siblings (Vercel must not attach Railway). */
export function selectRestConnections(
  prompt: string,
  connections: RestConnection[],
  selectedMcpProviders: string[] = [],
): RestConnection[] {
  const explicitRest = connections.filter((connection) => explicitProvider(prompt, connection.slug));
  const explicitlyNamed = new Set(explicitRest.map((connection) => connection.slug));
  const categoriesNamed = new Set<string>();
  for (const connection of explicitRest) {
    const category = categoryFor(connection.slug);
    if (category) categoriesNamed.add(category);
  }
  for (const slug of selectedMcpProviders) {
    if (!explicitProvider(prompt, slug)) continue;
    const category = categoryFor(slug);
    if (category) categoriesNamed.add(category);
    if (["vercel", "cloudflare"].includes(slug)) categoriesNamed.add("deploy");
    if (slug === "stripe") categoriesNamed.add("content");
  }
  return connections.filter((connection) => {
    if (explicitlyNamed.has(connection.slug)) return true;
    const category = categoryFor(connection.slug);
    return Boolean(category && !categoriesNamed.has(category) && categoryHint(category, prompt));
  });
}

function requiredCredential(credentials: Record<string, string>, key: string): string {
  const value = credentials[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The saved provider connection is missing required field: " + key);
  }
  return value;
}

function boundedLimit(value: unknown, fallback = 10, maximum = 20): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}
function boundedString(value: unknown, name: string, max = 250): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("A valid " + name + " is required.");
  return value.trim();
}
function redactResponse(value: unknown): string {
  let serialized = "";
  try { serialized = JSON.stringify(value, null, 2) ?? String(value); } catch { serialized = String(value); }
  return serialized.length > 14_000 ? serialized.slice(0, 14_000) + "\n[Output truncated to keep the response bounded.]" : serialized;
}
async function jsonRequest(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try { if (text) body = JSON.parse(text); } catch { /* keep provider's text response */ }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Provider authentication failed (HTTP 401). Check the saved credential.");
    if (response.status === 403) throw new Error("Provider denied this read (HTTP 403). The key may lack the required read scope.");
    if (response.status === 404) throw new Error("Provider resource was not found (HTTP 404). Check the selected site/project ID.");
    if (response.status === 429) throw new Error("Provider rate limit reached (HTTP 429). Try again later.");
    throw new Error("Provider request failed (HTTP " + response.status + ").");
  }
  return body;
}
async function graphqlRequest(
  fetcher: Fetcher, url: string, headers: Record<string, string>, query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const result = await jsonRequest(fetcher, url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }) as Record<string, unknown>;
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const messages = result.errors.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).message : "").filter((item) => typeof item === "string");
    throw new Error(messages.join("; ") || "Provider GraphQL query failed.");
  }
  return result.data ?? result;
}
function schemaField(type = "string", description?: string): Record<string, unknown> {
  return { type, ...(description ? { description } : {}) };
}
function makeTool(
  slug: string, name: string, description: string,
  properties: Record<string, unknown> = {}, required: string[] = [],
): ToolDefinition {
  return { name: slug + "__" + name, description, input_schema: { type: "object", properties, required } };
}

export function buildRestQueryTools(connections: RestConnection[], fetcher: Fetcher = secureMcpFetch): RestQueryToolSet {
  const tools: ToolDefinition[] = [];
  const executors = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  const providersBySlug = new Map<string, RestQueryProvider>();

  const add = (
    connection: RestConnection, name: string, description: string,
    properties: Record<string, unknown>, required: string[],
    execute: (args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    const tool = makeTool(connection.slug, name, description, properties, required);
    tools.push(tool);
    executors.set(tool.name, async (args) => redactResponse(await execute(args)));
    providersBySlug.set(connection.slug, { slug: connection.slug, name: labelFor(connection.slug) });
  };
  const limitField = { limit: schemaField("integer", "Maximum results to return, 1–20.") };

  for (const connection of connections) {
    const slug = connection.slug;
    const creds = connection.credentials;
    if (slug === "netlify") {
      const headers = { Authorization: "Bearer " + requiredCredential(creds, "netlify_token"), Accept: "application/json" };
      add(connection, "list_sites", "Read the connected Netlify account's sites. Use a returned site ID to inspect its deployments.", limitField, [], async (args) =>
        jsonRequest(fetcher, "https://api.netlify.com/api/v1/sites?per_page=" + boundedLimit(args.limit), { headers }));
      add(connection, "list_deployments", "Read recent Netlify deployments for a site ID from list_sites.", {
        site_id: schemaField("string", "Site ID from the Netlify list_sites result."), ...limitField,
      }, ["site_id"], async (args) => {
        const siteId = encodeURIComponent(boundedString(args.site_id, "site_id"));
        return jsonRequest(fetcher, "https://api.netlify.com/api/v1/sites/" + siteId + "/deploys?per_page=" + boundedLimit(args.limit), { headers });
      });
      continue;
    }

    if (slug === "railway") {
      const headers = { Authorization: "Bearer " + requiredCredential(creds, "api_token") };
      const endpoint = "https://backboard.railway.com/graphql/v2";
      add(connection, "list_projects", "Read projects available to this Railway account token. Use a returned project ID with list_services.", {}, [], async () =>
        graphqlRequest(fetcher, endpoint, headers, "query LampCodeProjects { me { projects { edges { node { id name } } } } }"));
      add(connection, "list_services", "Read services in a Railway project. Use the project ID returned by list_projects.", {
        project_id: schemaField("string", "Project ID from list_projects."),
      }, ["project_id"], async (args) => graphqlRequest(
        fetcher, endpoint, headers,
        "query LampCodeServices($id: String!) { project(id: $id) { id name services { edges { node { id name } } } } }",
        { id: boundedString(args.project_id, "project_id") },
      ));
      add(connection, "list_deployments", "Read recent Railway deployments for a project and service ID. This query does not deploy or change anything.", {
        project_id: schemaField("string", "Project ID from list_projects."),
        service_id: schemaField("string", "Service ID from list_services."),
        limit: schemaField("integer", "Maximum deployments to return (1–20)."),
      }, ["project_id", "service_id"], async (args) => graphqlRequest(
        fetcher, endpoint, headers,
        "query LampCodeDeployments($input: DeploymentListInput!, $first: Int!) { deployments(input: $input, first: $first) { edges { node { id status createdAt } } pageInfo { hasNextPage endCursor } } }",
        {
          input: {
            projectId: boundedString(args.project_id, "project_id"),
            serviceId: boundedString(args.service_id, "service_id"),
          },
          first: boundedLimit(args.limit),
        },
      ));
      add(connection, "get_deployment_logs", "Read logs for one Railway deployment ID. This only retrieves logs; it does not restart or redeploy the service.", {
        deployment_id: schemaField("string", "Deployment ID from list_deployments."),
        limit: schemaField("integer", "Maximum log entries to return (1–100)."),
      }, ["deployment_id"], async (args) => graphqlRequest(
        fetcher, endpoint, headers,
        "query LampCodeDeploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }",
        {
          deploymentId: boundedString(args.deployment_id, "deployment_id"),
          limit: boundedLimit(args.limit, 50, 100),
        },
      ));
      continue;
    }

    if (slug === "shopify") {
      const url = "https://" + requiredCredential(creds, "shopify_store_domain") + "/admin/api/2026-10/graphql.json";
      const headers = { "X-Shopify-Access-Token": requiredCredential(creds, "shopify_admin_token") };
      add(connection, "list_products", "Read recent Shopify products; this query never edits products.", limitField, [], async (args) =>
        graphqlRequest(fetcher, url, headers, "query LampCodeProducts($first: Int!) { products(first: $first, sortKey: UPDATED_AT, reverse: true) { edges { node { id title handle status updatedAt } } pageInfo { hasNextPage } } }", { first: boundedLimit(args.limit) }));
      add(connection, "list_orders", "Read recent Shopify orders. Requires read_orders scope; no order is changed.", limitField, [], async (args) =>
        graphqlRequest(fetcher, url, headers, "query LampCodeOrders($first: Int!) { orders(first: $first, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } } } pageInfo { hasNextPage } } }", { first: boundedLimit(args.limit) }));
      continue;
    }

    if (slug === "wordpress") {
      const base = requiredCredential(creds, "wordpress_site_url").replace(/\/+$/, "") + "/wp-json/wp/v2";
      const auth = "Basic " + Buffer.from(requiredCredential(creds, "wordpress_username") + ":" + requiredCredential(creds, "wordpress_app_password")).toString("base64");
      const headers = { Authorization: auth, Accept: "application/json" };
      add(connection, "list_posts", "Read posts from the connected WordPress site.", limitField, [], async (args) =>
        jsonRequest(fetcher, base + "/posts?per_page=" + boundedLimit(args.limit) + "&_fields=id,date,slug,status,link,title", { headers }));
      add(connection, "list_pages", "Read pages from the connected WordPress site.", limitField, [], async (args) =>
        jsonRequest(fetcher, base + "/pages?per_page=" + boundedLimit(args.limit) + "&_fields=id,date,slug,status,link,title", { headers }));
      continue;
    }

    if (slug === "mailchimp") {
      const apiKey = requiredCredential(creds, "api_key");
      const region = apiKey.match(/-([a-z0-9]+)$/i)?.[1];
      if (!region) continue;
      const headers = { Authorization: "Basic " + Buffer.from("anystring:" + apiKey).toString("base64"), Accept: "application/json" };
      add(connection, "list_campaigns", "Read recent Mailchimp campaigns and their status/send time.", limitField, [], async (args) =>
        jsonRequest(fetcher, "https://" + region + ".api.mailchimp.com/3.0/campaigns?count=" + boundedLimit(args.limit) + "&sort_field=send_time&sort_dir=DESC", { headers }));
      add(connection, "list_audiences", "Read Mailchimp audiences and subscriber counts.", limitField, [], async (args) =>
        jsonRequest(fetcher, "https://" + region + ".api.mailchimp.com/3.0/lists?count=" + boundedLimit(args.limit), { headers }));
      continue;
    }

    if (slug === "resend") {
      const headers = { Authorization: "Bearer " + requiredCredential(creds, "api_key"), Accept: "application/json" };
      add(connection, "list_domains", "Read domains configured in Resend. Sending-only keys may lack domain-read permission.", {}, [], async () =>
        jsonRequest(fetcher, "https://api.resend.com/domains", { headers }));
      continue;
    }

    if (slug === "twilio") {
      const accountSid = requiredCredential(creds, "account_sid");
      const headers = { Authorization: "Basic " + Buffer.from(accountSid + ":" + requiredCredential(creds, "auth_token")).toString("base64"), Accept: "application/json" };
      add(connection, "list_messages", "Read recent Twilio messages from the connected account.", limitField, [], async (args) =>
        jsonRequest(fetcher, "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(accountSid) + "/Messages.json?PageSize=" + boundedLimit(args.limit), { headers }));
      add(connection, "list_calls", "Read recent Twilio calls from the connected account.", limitField, [], async (args) =>
        jsonRequest(fetcher, "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(accountSid) + "/Calls.json?PageSize=" + boundedLimit(args.limit), { headers }));
      continue;
    }

    if (slug === "sendgrid") {
      const headers = { Authorization: "Bearer " + requiredCredential(creds, "api_key"), Accept: "application/json" };
      add(connection, "list_scopes", "Read permissions granted to this SendGrid API key. SendGrid does not provide general sent-email history through this API.", {}, [], async () =>
        jsonRequest(fetcher, "https://api.sendgrid.com/v3/scopes", { headers }));
    }
  }

  return { tools, executors, providers: [...providersBySlug.values()] };
}

function labelFor(slug: RestProviderSlug): string {
  switch (slug) {
    case "netlify": return "Netlify";
    case "railway": return "Railway";
    case "shopify": return "Shopify";
    case "wordpress": return "WordPress";
    case "mailchimp": return "Mailchimp";
    case "resend": return "Resend";
    case "twilio": return "Twilio";
    case "sendgrid": return "SendGrid";
    case "framer": return "Framer";
  }
  return slug;
}
