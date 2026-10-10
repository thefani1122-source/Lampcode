/**
 * Keeps .env.example tied to the config schema. Run by `npm test`.
 *
 * This file does not exist because documentation is tidy. .env.example had
 * drifted for months into saying things that were false in a way nobody could
 * notice from inside the repo: it advertised OPENROUTER_API_KEY as "what calls
 * Claude/DeepSeek" — a variable the codebase never reads — and documented
 * Stripe billing that Paddle had replaced, while saying nothing at all about
 * the LLM_* trio that actually selects the provider. Somebody setting the
 * project up from it would configure a dead key and no model.
 *
 * It asserts COVERAGE, not values: every key in config.ts's schema has to be
 * mentioned, so adding one without documenting it fails here. It deliberately
 * does NOT assert that the example's defaults equal the schema's — three of
 * them were wrong on the first attempt at this file, which is the argument for
 * the check rather than against it, but a value is a thing to look up in
 * config.ts and duplicating it here would just be a second place to be wrong.
 */

import { readFileSync } from "node:fs";

let failures = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}`);
}

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const configSrc = readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");

// The schema's own keys, read as text rather than by importing config.ts —
// importing it would validate the real environment and pull in its dependencies
// for what is a question about a string. Same reason review-units.ts copies the
// baked-file list instead of importing it.
const schemaKeys = [...configSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);

ok("the config schema was parsed at all", schemaKeys.length > 20);

const missing = schemaKeys.filter((k) => !example.includes(k));
if (missing.length > 0) {
  console.log(`    undocumented in .env.example: ${missing.join(", ")}`);
}
ok("every config schema key is mentioned in .env.example", missing.length === 0);

// Vars read straight off process.env, outside the schema. They are no less
// required for a working setup, and being outside the schema is exactly why
// they are easy to leave undocumented.
const OUT_OF_SCHEMA = ["MAX_BUILD_COST_USD", "ADMIN_EMAILS", "E2B_TEMPLATE_ID"];
const missingExtra = OUT_OF_SCHEMA.filter((k) => !example.includes(k));
if (missingExtra.length > 0) {
  console.log(`    undocumented: ${missingExtra.join(", ")}`);
}
ok("vars read directly from process.env are documented too", missingExtra.length === 0);

// The specific falsehoods that made this file necessary. A regression here
// means somebody reinstated a provider the code does not use.
ok(
  "OPENROUTER_API_KEY is not advertised as the model provider",
  !/^OPENROUTER_API_KEY=/m.test(example),
);
ok("the current provider's endpoint var is present and uncommented", /^LLM_ENDPOINT_URL=/m.test(example));
ok("the model name var is present and uncommented", /^LLM_MODEL_NAME=/m.test(example));

// WAITLIST_MODE and its frontend twin have to be set together or an admin is
// let through by the API and blocked by the UI.
ok("the waitlist gate's frontend counterpart is mentioned", example.includes("VITE_WAITLIST_MODE"));
ok("the admin list's frontend counterpart is mentioned", example.includes("VITE_ADMIN_EMAILS"));

if (failures > 0) {
  console.error(`\n${failures} .env.example case(s) FAILED`);
  process.exit(1);
}
console.log("\nAll .env.example cases passed.");
