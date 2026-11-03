import { shopifyQueryHandler, wordpressQueryHandler, twilioQueryHandler, sendgridQueryHandler, mailchimpQueryHandler, normalizeBaseUrl, mailchimpDc } from "../src/agents/tools/rest-queries.js";
import { AGENTIC_BUILD_TOOLS as TOOL_LIST } from "../src/agents/tools.js";
import { REGISTRY } from "../src/agents/tools/registry.js";
import { narrateTool } from "../src/agents/tool-narration.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

// Every new tool is defined, registered, and narrated.
for (const name of ["shopify_query", "wordpress_query", "twilio_query", "sendgrid_query", "mailchimp_query"]) {
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

if (failures) process.exit(1);
console.log("\nAll REST query tool checks passed.");
