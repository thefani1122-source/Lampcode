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
import { PromptBuilder } from "../src/agents/prompt-builder.js";

const CONTRACT_WAS_CUT = "Middle reference/guidance material compacted";
const REFERENCE_WAS_SHED = "REFERENCE MATERIAL OMITTED";

type Shape = {
  label: string;
  markers: string[];
  /** Shape-specific blocks that must survive, on top of UNIVERSAL below. */
  mustContain: string[];
};

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
  },
];

let shedAtLeastOnce = false;

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

  for (const marker of [...UNIVERSAL, ...shape.mustContain]) {
    assert.ok(
      systemPrompt.includes(marker),
      `${shape.label}: load-bearing block missing from the compiled prompt — ${JSON.stringify(marker)}`,
    );
  }

  if (systemPrompt.includes(REFERENCE_WAS_SHED)) {
    shedAtLeastOnce = true;
    // A shed section must leave a signpost, not a silent hole: a model that is
    // not told the catalogue is missing reads its absence as "no conventions
    // exist here" and invents its own.
    assert.match(
      systemPrompt,
      /call list_skills to see what exists and load_skill to read any one of them/,
      `${shape.label}: reference section was dropped without telling the model how to get it back`,
    );
    assert.ok(
      !systemPrompt.includes("=== BEGIN REFERENCE MATERIAL"),
      `${shape.label}: reference section was replaced but its opening boundary was left behind`,
    );
  }
}

// The largest shapes are over the ceiling, so at least one of them must have
// taken the shed path. If none did, this file is no longer testing anything —
// either the prompt shrank a lot or the ceiling was raised past every shape.
assert.ok(
  shedAtLeastOnce,
  "no shape exercised the shed path; this test no longer covers the overflow behaviour it was written for",
);

console.log("System prompt ceiling / shed-order tests passed.");
