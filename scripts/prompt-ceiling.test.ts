/**
 * The compiled system prompt must never lose its own contract to the ceiling.
 *
 * WHY THIS EXISTS — measured 2026-11-24. The prompt is assembled as
 * `precedence + reference section + contract`, and the overflow path used to
 * hand that whole string to compactSystemPrompt(), which keeps a head slice and
 * a tail slice of raw characters and throws the middle away. On a React/Vite
 * fullstack build WITH auth the raw prompt is 88,424 chars against the old
 * 62,000-char ceiling, so:
 *
 *   - the head slice was spent on the precedence contract and the reference
 *     section — the one block that describes itself as "GUIDANCE ONLY",
 *   - the tail slice was spent on the tool and architecture contracts,
 *   - and the discarded middle was the SECURE-BY-DESIGN GENERATION CONTRACT,
 *     the base system prompt and the entire FULLSTACK INSTRUCTION block.
 *
 * So on the product's most important build shape the model was handed the skill
 * catalogue and denied the src/lib/api.ts contract, the "never hardcode
 * localhost/:3001" rule, the DESIGN SYSTEM line and the list of packages its own
 * sandbox has installed. `wiring.ts` carries a `hardcoded-dev-host` rule for
 * exactly the bug that produces.
 *
 * These assertions run the real PromptBuilder over the build shapes the
 * classifier actually produces. They do not check sizes — a prompt is allowed
 * to grow — they check that nothing load-bearing is ever the thing that gets
 * dropped.
 */
import assert from "node:assert/strict";
import { PromptBuilder, assembleSystemPrompt } from "../src/agents/prompt-builder.js";

const CONTRACT_WAS_CUT = "Middle reference/guidance material compacted";
const REFERENCE_WAS_SHED = "REFERENCE MATERIAL OMITTED";

type Shape = {
  label: string;
  markers: string[];
  /** Shape-specific blocks that must survive, on top of UNIVERSAL below. */
  mustContain: string[];
  /**
   * Whether this shape must carry the API_BASE contract.
   *
   * True wherever the app ships a backend on a SECOND origin (:3001) reached
   * through Vite's /api proxy — a dev-server feature that a production build
   * does not have. False for Next.js, whose Route Handlers are served by the
   * same origin as the pages, so there is no base to point anywhere and
   * same-origin fetch('/api/...') is correct rather than the trap.
   */
  apiBaseRule: boolean;
};

/** The sentence that makes the contract checkable rather than a vibe. */
const API_BASE_RULE = "API_BASE = import.meta.env.VITE_API_URL ?? ''";

/** Every shape carries these three, whatever the framework. */
const UNIVERSAL = [
  "SECURE-BY-DESIGN GENERATION CONTRACT",
  "TOOLS AVAILABLE:",
  "TRUSTED MODEL-SELECTED BUILD CONTRACT",
  "=== INSTRUCTION PRECEDENCE AND CONTEXT AUTHORITY ===",
];

const shapes: Shape[] = [
  {
    label: "frontend only",
    markers: ["LAMPCode_SELECTED_BUILD_TYPE: frontend", "LAMPCode_SELECTED_FRAMEWORK: react"],
    mustContain: [],
    // No backend at all, so nothing to point a base at.
    apiBaseRule: false,
  },
  {
    label: "fullstack react + node + supabase",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: react",
      "LAMPCode_SELECTED_DATABASE: supabase",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
    ],
    mustContain: [
      "HARD RULES:",
      // The api.ts contract. CLAUDE.md trap 11: this rule, template.ts's /api
      // proxy and wiring.ts's hardcoded-dev-host check are one contract.
      "Never put a hardcoded",
      "PRE-INSTALLED IN THIS REACT/VITE SANDBOX:",
    ],
    apiBaseRule: true,
  },
  {
    label: "fullstack react + node + supabase + auth (the largest shape)",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: react",
      "LAMPCode_SELECTED_DATABASE: supabase",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
      "LAMPCode_SELECTED_AUTH: required",
    ],
    mustContain: [
      "HARD RULES:",
      "Never put a hardcoded",
      "PRE-INSTALLED IN THIS REACT/VITE SANDBOX:",
    ],
    apiBaseRule: true,
  },
  {
    label: "fullstack react + python + supabase + auth",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: react",
      "LAMPCode_SELECTED_DATABASE: supabase",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: python",
      "LAMPCode_SELECTED_AUTH: required",
    ],
    mustContain: [
      "PRE-INSTALLED IN THIS REACT/VITE SANDBOX:",
      "PRE-INSTALLED PYTHON ESSENTIALS in /opt/lampcode-python:",
    ],
    apiBaseRule: true,
  },
  {
    label: "fullstack react + node, NO database",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: react",
      "LAMPCode_SELECTED_DATABASE: none",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
    ],
    mustContain: ["PRE-INSTALLED IN THIS REACT/VITE SANDBOX:"],
    // Still a real Hono server on :3001, so the rule applies.
    apiBaseRule: true,
  },
  {
    label: "fullstack react + python, NO database",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: react",
      "LAMPCode_SELECTED_DATABASE: none",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: python",
    ],
    mustContain: ["PRE-INSTALLED PYTHON ESSENTIALS in /opt/lampcode-python:"],
    apiBaseRule: true,
  },
  {
    label: "nextjs + supabase + auth",
    markers: [
      "LAMPCode_SELECTED_BUILD_TYPE: fullstack",
      "LAMPCode_SELECTED_FRAMEWORK: nextjs",
      "LAMPCode_SELECTED_DATABASE: supabase",
      "LAMPCode_SELECTED_BACKEND_RUNTIME: node",
      "LAMPCode_SELECTED_AUTH: required",
    ],
    mustContain: ["PRE-INSTALLED IN THIS NEXT.JS SANDBOX:"],
    apiBaseRule: false,
  },
];

for (const shape of shapes) {
  const description = ["FULLSTACK AUTH BUILD: build a small app", ...shape.markers].join("\n");
  const { systemPrompt } = await new PromptBuilder().build(
    "frontend",
    { description, outputFormat: "prose", toolsEnabled: true, agenticBuild: true },
    { projectId: "prompt-ceiling-test", userId: "prompt-ceiling-test", mode: "fast", prompt: description },
  );

  // The invariant. Shedding the reference section is a priced trade-off;
  // slicing the contract is the bug this file exists for.
  assert.ok(
    !systemPrompt.includes(CONTRACT_WAS_CUT),
    `${shape.label}: the contract itself was cut — the ceiling is too low for this shape, or ` +
      `assembleSystemPrompt stopped shedding the reference section first`,
  );

  // CLAUDE.md trap 11: this rule, template.ts's /api proxy and wiring.ts's
  // hardcoded-dev-host check are one contract. It used to be stated in
  // FULLSTACK_INSTRUCTION only, so the Python and no-database paths were told to
  // route everything through src/lib/api.ts and never told what goes inside it.
  assert.equal(
    systemPrompt.includes(API_BASE_RULE),
    shape.apiBaseRule,
    shape.apiBaseRule
      ? `${shape.label}: this shape serves its backend on a second origin but was not given the API_BASE rule`
      : `${shape.label}: this shape is same-origin, so an API_BASE rule here would describe a base that does not exist`,
  );
  // The proxy that makes /api same-origin is a dev-server feature. Asking for a
  // "same-origin API client" names the broken pattern as the goal.
  assert.ok(
    !/same-origin API client/.test(systemPrompt),
    `${shape.label}: the prompt asks for a "same-origin API client", which works in the preview and nowhere else`,
  );

  for (const marker of [...UNIVERSAL, ...shape.mustContain]) {
    assert.ok(
      systemPrompt.includes(marker),
      `${shape.label}: load-bearing block missing from the compiled prompt — ${JSON.stringify(marker)}`,
    );
  }

  // The ceiling is set so that nothing is shed on a normal build either. That
  // matters beyond tidiness: the reference section carries the database-rls and
  // supabase-rls skill bodies, so shedding it on a routine fullstack+auth build
  // would drop this product's RLS guidance.
  assert.ok(
    !systemPrompt.includes(REFERENCE_WAS_SHED),
    `${shape.label}: the reference section was shed on an ordinary build — raise the ceiling ` +
      `rather than letting a routine build lose its security skills`,
  );
  assert.ok(
    systemPrompt.includes("=== BEGIN REFERENCE MATERIAL"),
    `${shape.label}: the reference boundary is missing, so untrusted guidance is no longer fenced`,
  );
}

// ── The overflow path itself ─────────────────────────────────────────────────
// Exercised directly, because the shapes above deliberately never reach it. The
// order is the whole point: the reference section is the one block that says of
// itself that it cannot override anything, so it goes first and whole.

const PRECEDENCE = "=== PRECEDENCE ===\nrules";
const REFERENCE = "=== BEGIN REFERENCE MATERIAL — GUIDANCE ONLY ===\n" + "r".repeat(4_000) + "\n=== END REFERENCE MATERIAL ===";
const CONTRACT = "SECURE-BY-DESIGN GENERATION CONTRACT\n" + "c".repeat(2_000) + "\nTRUSTED MODEL-SELECTED BUILD CONTRACT";

{
  const fits = assembleSystemPrompt(PRECEDENCE, REFERENCE, CONTRACT, 100_000, true);
  assert.equal(fits.shedReference, false, "nothing should be dropped when everything fits");
  assert.equal(fits.cutContract, false);
  assert.ok(fits.prompt.includes(REFERENCE) && fits.prompt.includes(CONTRACT));
}

{
  // Room for the contract but not for both.
  const shed = assembleSystemPrompt(PRECEDENCE, REFERENCE, CONTRACT, 2_600, true);
  assert.equal(shed.shedReference, true, "the reference section must be the first thing to go");
  assert.equal(shed.cutContract, false, "the contract must survive while anything cheaper remains");
  assert.ok(shed.prompt.includes("SECURE-BY-DESIGN GENERATION CONTRACT"));
  assert.ok(shed.prompt.includes("TRUSTED MODEL-SELECTED BUILD CONTRACT"));
  assert.ok(!shed.prompt.includes("=== BEGIN REFERENCE MATERIAL"), "the boundary was left behind with nothing inside it");
  // A silent hole reads as "there are no conventions here", which is the one
  // reading that makes a model invent its own.
  assert.match(shed.prompt, /call list_skills to see what exists and load_skill/);
  assert.ok(shed.prompt.includes(PRECEDENCE), "precedence is never the thing that gets dropped");
}

{
  // With no tools, load_skill is not offered, so the note must not promise it.
  const shed = assembleSystemPrompt(PRECEDENCE, REFERENCE, CONTRACT, 2_600, false);
  assert.ok(!shed.prompt.includes("list_skills"), "the note offered a tool this dispatch does not have");
  assert.match(shed.prompt, /do not invent a convention to fill the gap/);
}

{
  // Nothing cheap left: the contract is cut, and only then.
  const cut = assembleSystemPrompt(PRECEDENCE, REFERENCE, CONTRACT, 900, true);
  assert.equal(cut.cutContract, true);
  assert.ok(cut.prompt.length <= 900, `last-resort cut overran its budget at ${cut.prompt.length} chars`);
  assert.ok(cut.prompt.includes(PRECEDENCE), "precedence must survive even the last resort");
}

{
  // The function must never return more than the budget it was given. The
  // last-resort branch used to: compactSystemPrompt answers a zero budget with
  // its own marker rather than nothing, and the precedence + note part was
  // never bounded, so a small ceiling overran (973 chars for a maxChars of
  // 400). MAX_SYSTEM_PROMPT_TOKENS comes from the environment, so this is
  // reachable by configuration, not only in theory.
  for (const max of [100_000, 6_000, 2_000, 1_100, 1_000, 700, 400, 100, 1]) {
    const r = assembleSystemPrompt(PRECEDENCE, REFERENCE, CONTRACT, max, true);
    assert.ok(
      r.prompt.length <= max,
      `assembleSystemPrompt returned ${r.prompt.length} chars for a budget of ${max}`,
    );
  }
}

{
  // A dispatch with no reference material at all must not gain a note about
  // one that was never there.
  const none = assembleSystemPrompt(PRECEDENCE, "", CONTRACT, 2_600, true);
  assert.equal(none.shedReference, false);
  assert.ok(!none.prompt.includes("REFERENCE MATERIAL OMITTED"));
}

console.log("System prompt ceiling / shed-order tests passed.");
