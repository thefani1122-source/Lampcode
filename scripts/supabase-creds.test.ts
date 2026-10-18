/**
 * Cases for reading a Supabase project's URL and anon key off an MCP result.
 * Run by `npm test`.
 *
 * MEASURED 2026-10-18, and the reason these exist. Connecting a project failed
 * four times with "the project returned no URL or anon key" while BOTH tool
 * calls succeeded and not one warning was logged — because the extractor read
 * only `content[].text`, and this server answers these two tools in
 * `structuredContent`. A tool that returns nothing and a tool that returns
 * somewhere else are indistinguishable when you only look in one place.
 *
 * The fixtures below are the REAL shapes, copied from live calls against
 * project `wdzbancieifhheugtxph` — not invented ones. A case built on a guessed
 * shape would have passed happily while production kept failing, which is
 * exactly what the previous code did.
 */

import { extractAnonKey } from "../src/mcp/supabase-mcp.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const LEGACY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.sig-part";
const PUBLISHABLE = "sb_publishable_XPMxTRr5o0o0otb5IYl3KA_rU-enaRU";

/** The live shape of get_publishable_keys. */
const KEYS_PAYLOAD = {
  keys: [
    { api_key: LEGACY, name: "anon", type: "legacy", disabled: false, id: "anon" },
    { api_key: PUBLISHABLE, name: "default", type: "publishable", disabled: false, id: "22cc38cd" },
  ],
};

// ── the regression ───────────────────────────────────────────────────────────

// structuredContent with an EMPTY content array: the exact production failure.
check(
  "a key in structuredContent is found when content is empty",
  extractAnonKey({ text: "", data: KEYS_PAYLOAD }),
  LEGACY,
);

// The same server, answering in text instead. Both must work, because which
// one a server uses is not ours to control.
check(
  "and the same payload as text still works",
  extractAnonKey({ text: JSON.stringify(KEYS_PAYLOAD), data: KEYS_PAYLOAD }),
  LEGACY,
);

// ── which key, and why ───────────────────────────────────────────────────────

// The legacy anon key is preferred deliberately: the whole auth.uid() story the
// prompt teaches, and the JWT the backend forwards, are built on it.
check("the legacy anon key wins over the publishable one", extractAnonKey({ text: "", data: KEYS_PAYLOAD }), LEGACY);

check(
  "a project that retired its legacy key still connects",
  extractAnonKey({ text: "", data: { keys: [KEYS_PAYLOAD.keys[1]] } }),
  PUBLISHABLE,
);

// Handing out a key that will be refused is the same class of bug as returning
// nothing: a confident answer that does not work.
check(
  "a disabled key is never handed out",
  extractAnonKey({
    text: "",
    data: { keys: [{ ...KEYS_PAYLOAD.keys[0], disabled: true }, KEYS_PAYLOAD.keys[1]] },
  }),
  PUBLISHABLE,
);

ok("every key disabled yields nothing, not a bad key", extractAnonKey({
  text: "",
  data: { keys: [{ ...KEYS_PAYLOAD.keys[0], disabled: true }] },
}) === null);

// ── older and simpler shapes, kept working ───────────────────────────────────

check("a single-object anon_key shape still works", extractAnonKey({ text: "", data: { anon_key: LEGACY } }), LEGACY);
check("a bare key in prose is the last resort", extractAnonKey({ text: `your key is ${LEGACY} ok`, data: null }), LEGACY);
check("a bare publishable key in prose too", extractAnonKey({ text: `key: ${PUBLISHABLE}`, data: null }), PUBLISHABLE);


// ── found wherever it sits ───────────────────────────────────────────────────
// Two deployments were spent guessing WHERE the answer lives — content[].text,
// then structuredContent — and it was in neither. These pin the third answer:
// values this distinctive are found by what they ARE.

check(
  "a key buried in an unexpected envelope is still found",
  extractAnonKey({ text: JSON.stringify({ result: { data: { items: [{ secret: LEGACY }] } } }), data: null }),
  LEGACY,
);

check(
  "and so is a publishable one",
  extractAnonKey({ text: JSON.stringify({ weird: { nesting: [[{ k: PUBLISHABLE }]] } }), data: null }),
  PUBLISHABLE,
);

ok(
  "an envelope with no key at all still yields null",
  extractAnonKey({ text: JSON.stringify({ result: { data: { items: [] } } }), data: null }) === null,
);

// ── nothing is nothing ───────────────────────────────────────────────────────

ok("an empty result yields null", extractAnonKey({ text: "", data: null }) === null);
ok("an empty key list yields null", extractAnonKey({ text: "", data: { keys: [] } }) === null);
ok("unrelated prose yields null", extractAnonKey({ text: "no keys were found", data: null }) === null);

console.log(
  failures === 0 ? "\nAll Supabase cred cases passed." : `\n${failures} Supabase cred case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
