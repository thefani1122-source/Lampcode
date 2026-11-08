import { REST_WRITE_DEFS, buildRestWriteRegistry, REST_WRITE_PROVIDER, shopifyWriteHandler, mailchimpWriteHandler, sendgridWriteHandler, twilioWriteHandler } from "../src/agents/tools/rest-writes.js";
import { TOOL_DEFINITIONS, AGENTIC_BUILD_TOOLS } from "../src/agents/tools.js";
import { REGISTRY } from "../src/agents/tools/registry.js";
import { narrateTool } from "../src/agents/tool-narration.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name}`); }
}

// All five write tools are defined and provider-mapped.
for (const name of ["shopify_write", "wordpress_write", "twilio_write", "sendgrid_write", "mailchimp_write"]) {
  ok(`${name} is defined`, REST_WRITE_DEFS.some((t) => t.name === name));
  ok(`${name} maps to a provider`, Boolean(REST_WRITE_PROVIDER[name]));
  ok(`${name} is narrated`, narrateTool(name).label.length > 0);
}

// Writes must NEVER be reachable without the approval gate: they are absent
// from the always-on tool lists and from the static handler registry.
const staticNames = new Set([...TOOL_DEFINITIONS, ...AGENTIC_BUILD_TOOLS].map((t) => t.name));
for (const name of REST_WRITE_DEFS.map((t) => t.name)) {
  ok(`${name} is NOT in the static tool lists`, !staticNames.has(name));
  ok(`${name} is NOT in the static registry`, !REGISTRY.has(name));
}

// The registry includes a provider only when credentials exist (fail closed).
const emptyRegistry = buildRestWriteRegistry({});
ok("no credentials → no write tools offered", emptyRegistry.size === 0);
const fullRegistry = buildRestWriteRegistry({
  shopify: { shopDomain: "my-store.myshopify.com", adminApiAccessToken: "shpat_x" },
  wordpress: { siteUrl: "example.com", username: "admin", appPassword: "abcd" },
  twilio: { account_sid: "AC", auth_token: "t" },
  sendgrid: { api_key: "SG.x" },
  mailchimp: { api_key: "abc-us1" },
});
ok("all five write tools offered with credentials", fullRegistry.size === 5);
ok("twilio write is strong-approval", fullRegistry.get("twilio_write")?.tier === "strong-approval");
for (const name of ["shopify_write", "wordpress_write", "sendgrid_write", "mailchimp_write"])
  ok(`${name} is approval tier`, fullRegistry.get(name)?.tier === "approval");
ok("write metas carry a local executor", typeof fullRegistry.get("shopify_write")?.localExecute === "function");
ok("partial credentials only offer that provider",
  buildRestWriteRegistry({ sendgrid: { api_key: "SG.x" } }).size === 1);

// Validation paths speak before any network call is made.
const noTitle = await shopifyWriteHandler({ action: "create_product" }, fullCtx());
ok("shopify create without a title is refused", noTitle.includes("title"));
function fullCtx(): never { return { serviceCredentials: { shopify: { shopDomain: "my-store.myshopify.com", adminApiAccessToken: "shpat_x" }, sendgrid: { api_key: "SG.x" }, mailchimp: { api_key: "abc-us1" }, twilio: { account_sid: "AC", auth_token: "t" } } } as never; }

const noRecipient = await sendgridWriteHandler({ action: "send_email", subject: "Hi", text: "Body" }, fullCtx());
ok("sendgrid email without a recipient is refused", noRecipient.includes("to"));

const noTwilioFields = await twilioWriteHandler({ action: "send_sms", to: "+1" }, fullCtx());
ok("twilio without from/body is refused", noTwilioFields.includes("required"));

const noList = await mailchimpWriteHandler({ action: "add_member", email: "a@b.co" }, fullCtx());
ok("mailchimp member without a list id is refused", noList.includes("list_id"));

const unknownAction = await shopifyWriteHandler({ action: "delete_store" }, fullCtx());
ok("unknown write actions are refused", unknownAction.includes("Unknown action"));

if (failures) process.exit(1);
console.log("\nAll REST write tool checks passed.");

process.exit(0); // local assertions are complete; do not wait for optional Redis retries
