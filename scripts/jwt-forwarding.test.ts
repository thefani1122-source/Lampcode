/**
 * The prompt's data-access contract. Run by `npm test`.
 *
 * These read the prompt as TEXT and assert what it instructs, which is an odd
 * shape for a case until you look at why it exists. `G5`, 2026-10-17: the
 * generated backend built ONE Supabase client at module level with no auth
 * header, so `auth.uid()` was NULL inside every RLS policy the prompt teaches
 * three screens earlier. With a service key those policies were bypassed
 * entirely; with the anon key they denied everything. The prompt taught
 * correct RLS and then handed it a client that could never satisfy it.
 *
 * Nothing in a unit test can catch that, because the failure is in the English.
 * What CAN be caught is the contract going out of sync again — which it did
 * within this very change: the Python section's client was fixed while its two
 * route examples kept calling the old module-level `supabase`, which would
 * have shipped a NameError to every Python build. Case 7 is that bug.
 *
 * This is trap 4 in CLAUDE.md — prompt-vs-reality drift, the #1 bug class in
 * this repo — turned into something that fails on a laptop instead of on a
 * stranger's first app.
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

const prompt = readFileSync(new URL("../src/agents/prompt-builder.ts", import.meta.url), "utf8");
const buildRoute = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

// ── the service key is gone from every instruction ───────────────────────────

// Not "discouraged" — absent. An instruction that mentions a service key at all
// gives the model something to reach for, and reaching for it silently turns
// every RLS policy in the generated schema into decoration.
ok("the prompt never names a Supabase service key", !/SUPABASE_SERVICE_KEY/.test(prompt));
ok("neither does the Next.js instruction", !/SUPABASE_SERVICE_KEY/.test(buildRoute));
ok("nor a service-role key under any spelling", !/SERVICE_ROLE/i.test(prompt));

// ── the backend builds a client per request ──────────────────────────────────

ok("the Node backend is told to build a client per request", /function dbFor\s*\(/.test(prompt));
ok(
  "and to forward the caller's Authorization header into it",
  /global:\s*\{\s*headers:\s*token\s*\?\s*\{\s*Authorization/.test(prompt),
);
ok(
  "and warned off a module-level client explicitly",
  /never once at module level/i.test(prompt),
);

// The drift this change itself produced, caught before it shipped: the Python
// client was rewritten as db_for(req) while both route examples still called a
// module-level `supabase`, which no longer exists in the shape above.
ok(
  "the Python route examples use db_for, not a module-level client",
  /db_for\(req\)\.table\("riders"\)/.test(prompt) &&
    !/\n\s*return \(supabase\.table\(/.test(prompt),
);

ok("the Python client is also built per request", /def db_for\(req: Request\)/.test(prompt));

// ── the frontend sends the token the backend forwards ────────────────────────

// Half a forwarding chain is worse than none: the backend would stop bypassing
// RLS and start being denied by it, and every list in the app would empty out.
ok(
  "the generated frontend attaches the session token",
  /supabase\.auth\.getSession\(\)/.test(prompt) && /Authorization.*access_token|'Bearer ' \+ t/.test(prompt),
);
ok(
  "both the read and the write example send it",
  /getRiders[\s\S]{0,200}await authHeaders\(\)/.test(prompt) &&
    /createRider[\s\S]{0,300}await authHeaders\(\)/.test(prompt),
);

// ── the policies this is all in service of are still taught ──────────────────

// If a later edit ever drops the RLS section, forwarding a token becomes
// pointless: there would be no policy for auth.uid() to be read by.
ok("RLS policies are still taught with auth.uid()", /auth\.uid\(\)/.test(prompt));
ok(
  "and the model is told not to filter by user id itself",
  /RLS does it|redundant or a bug/i.test(prompt),
);


// ── the anti-fake rule must reach a FOLLOW-UP build ──────────────────────────
// Measured twice, 2026-10-17 and 2026-10-18: both fakes happened on follow-up
// builds ("sign-up doesn't work"), and the rule lived in DB_INSTRUCTIONS, which
// prompt-builder only includes when isFullstackMode is true. The rule was
// correct, well argued, and never sent.
//
// So it now also lives in the agentic block, which is present on every agentic
// build. These cases pin that placement, not the wording: a rule in the wrong
// section is the same as no rule.
{
  const agentic = prompt.slice(prompt.indexOf("HOW TO BUILD — THIS SECTION WINS"));
  ok("the agentic block forbids faking a feature", /NEVER fake a feature/i.test(agentic));
  ok("it names demo mode and localStorage specifically", /demo mode.*localStorage|localStorage stand-in/is.test(agentic));
  ok(
    "it tells the model to CHECK the backend claim, not assume it",
    /read_logs/.test(agentic) && /check_page/.test(agentic),
  );
  ok("it names the hardcoded-host trap", /localhost:3001/.test(agentic));
  ok("and says an honest failure is a result", /is a result/i.test(agentic));
}

console.log(
  failures === 0
    ? "\nAll JWT-forwarding contract cases passed."
    : `\n${failures} JWT-forwarding case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
