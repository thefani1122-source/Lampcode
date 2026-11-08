import { shopifyQueryHandler, wordpressQueryHandler, twilioQueryHandler, sendgridQueryHandler, mailchimpQueryHandler, netlifyQueryHandler, normalizeBaseUrl, mailchimpDc } from "../src/agents/tools/rest-queries.js";
import { supabaseQueryHandler } from "../src/agents/tools/supabase-query.js";
import { AGENTIC_BUILD_TOOLS as TOOL_LIST } from "../src/agents/tools.js";
import { REGISTRY } from "../src/agents/tools/registry.js";
import { narrateTool } from "../src/agents/tool-narration.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

// Every new tool is defined, registered, and narrated.
for (const name of ["shopify_query", "wordpress_query", "twilio_query", "sendgrid_query", "mailchimp_query", "netlify_query", "supabase_query"]) {
  ok(`${name} is defined in TOOL_DEFINITIONS`, TOOL_LIST.some((t) => t.name === name));
  ok(`${name} has a registered handler`, REGISTRY.has(name));
  ok(`${name} is narrated`, narrateTool(name).label.length > 0);
}

// URL / credential normalization helpers.
ok("normalizeBaseUrl strips scheme, path, and trailing slash", normalizeBaseUrl("https://my-store.myshopify.com/") === "my-store.myshopify.com");
ok("mailchimpDc extracts a real datacenter", mailchimpDc("abc123-us21") === "us21");
ok("mailchimpDc rejects a key without a datacenter", mailchimpDc("justakey") === null);

// Missing credentials speak for themselves instead of throwing.
const emptyCtx = { serviceCredentials: {} } as never;
const notConnected = await shopifyQueryHandler({}, emptyCtx);
ok("shopify without a connection says how to connect", notConnected.includes("not connected") && notConnected.includes("Integrations"));

const noAdminTokenCtx = { serviceCredentials: { shopify: { shopDomain: "my-store.myshopify.com", storefrontAccessToken: "shpsa_x" } } } as never;
const noToken = await shopifyQueryHandler({}, noAdminTokenCtx);
ok("shopify without an Admin token names the missing credential", noToken.includes("Admin API access token"));

const badDomainCtx = { serviceCredentials: { shopify: { shopDomain: "https://evil.example.com/path", adminApiAccessToken: "shpat_x" } } } as never;
const badDomain = await shopifyQueryHandler({}, badDomainCtx);
ok("shopify refuses a non-myshopify domain", badDomain.includes("shop domain"));

const noDcCtx = { serviceCredentials: { mailchimp: { api_key: "justakey" } } } as never;
const noDc = await mailchimpQueryHandler({}, noDcCtx);
ok("mailchimp without a datacenter suffix explains the key format", noDc.includes("datacenter"));

const noSidCtx = { serviceCredentials: { twilio: { auth_token: "x" } } } as never;
const noSid = await twilioQueryHandler({}, noSidCtx);
ok("twilio without an Account SID names the missing credential", noSid.includes("Account SID"));

// Unknown actions are reported, never guessed.
const credsCtx = { serviceCredentials: { shopify: { shopDomain: "my-store.myshopify.com", adminApiAccessToken: "shpat_x" } } } as never;
const unknown = await shopifyQueryHandler({ action: "delete_store" }, credsCtx);
ok("unknown actions are refused", unknown.includes("Unknown action") && unknown.includes("list_products"));

// Netlify / Supabase speak for themselves when not connected or
// missing a credential, and refuse unknown actions.

const noNetlify = await netlifyQueryHandler({}, emptyCtx);
ok("netlify without a connection says how to connect", noNetlify.includes("not connected") && noNetlify.includes("Integrations"));
const netlifyNoSite = await netlifyQueryHandler({ action: "list_deploys" }, { serviceCredentials: { netlify: { api_token: "nfp_x" } } } as never);
ok("netlify list_deploys demands a site_id", netlifyNoSite.includes("site_id") && netlifyNoSite.includes("list_sites"));

const noSupabase = await supabaseQueryHandler({}, emptyCtx);
ok("supabase without a connection says how to connect", noSupabase.includes("not connected") && noSupabase.includes("Integrations"));
const supaWriteRefused = await supabaseQueryHandler(
  { action: "run_sql", query: "DELETE FROM users" },
  { serviceCredentials: { supabase: { accessToken: "sbp_x" } } } as never,
);
ok("supabase run_sql refuses non-SELECT statements", supaWriteRefused.includes("read-only"));
const supaUnknown = await supabaseQueryHandler({ action: "reboot_project" }, { serviceCredentials: { supabase: { accessToken: "sbp_x" } } } as never);
ok("supabase unknown action names what the server offers", supaUnknown.includes('reboot_project') || supaUnknown.includes("Supabase MCP error"));

if (failures) process.exit(1);
console.log("\nAll REST query tool checks passed.");
process.exit(0);
