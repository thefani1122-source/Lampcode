/**
 * Cases for the pseudo-tool filter. Run by `npm test`.
 *
 * THE PRODUCTION FAILURE, a real build on 2026-10-18 (ShopHub): the model's
 * visible reasoning contained
 *
 *     <tool_code>
 *     <tool name="filesystem_list_allowed_directories">
 *
 * `filesystem_list_allowed_directories` is not a tool this product has. The
 * model did not call anything — it typed the SYNTAX of a call, as prose, and
 * prose is streamed to the user's chat verbatim. So a person watching their app
 * being built was shown XML naming a filesystem tool.
 *
 * Two things are pinned here. The markup never reaches a person, through either
 * door — the narration stream and the closing summary. And the detection is
 * narrow: these patterns must not eat a sentence about a `<Tool>` component or
 * a line of ordinary TSX, because a filter that swallows real reasoning is
 * worse than the leak it fixes.
 */

import { readFileSync } from "node:fs";
import {
  PseudoToolFilter,
  PSEUDO_TOOL_CORRECTION,
  hasPseudoToolMarkup,
  pseudoToolNames,
  stripPseudoToolMarkup,
} from "../src/agents/pseudo-tools.js";
import { extractBuildSummary } from "../src/agents/file-parser.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

// ── The exact production string ──────────────────────────────────────────────

const SHOPHUB = `I'll check the project first.
<tool_code>
<tool name="filesystem_list_allowed_directories">
</tool>
</tool_code>
Now building the store.`;

const stripped = stripPseudoToolMarkup(SHOPHUB);
check("the ShopHub markup is removed", !stripped.text.includes("tool_code") && !stripped.text.includes("filesystem_list_allowed_directories"));
check("the real prose around it survives", stripped.text.includes("I'll check the project first.") && stripped.text.includes("Now building the store."));
check("the attempted tool name is reported, not just dropped", stripped.names.includes("filesystem_list_allowed_directories"));
check("and it is detected as markup", hasPseudoToolMarkup(SHOPHUB));

// ── The other harnesses' shapes ──────────────────────────────────────────────

for (const [label, text] of [
  ["anthropic-style", '<function_calls>\n<invoke name="str_replace">\n</invoke>\n</function_calls>'],
  ["openai-style", '<tool_call>\n{"name":"read_file","arguments":{}}\n</tool_call>'],
  ["bracket-style", "[TOOL_CALL]read_file(x)[/TOOL_CALL]"],
  ["qwen-style", "<|tool_call|>"],
] as const) {
  check(`${label} markup is stripped`, stripPseudoToolMarkup(`before ${text} after`).text.replace(/\s+/g, " ").trim() === "before after");
}
check("a name in an invoke block is reported", pseudoToolNames('<invoke name="str_replace">').includes("str_replace"));

// ── Not a filter that eats real text ─────────────────────────────────────────
// A filter with false positives would delete the model's actual reasoning,
// which is worse than the leak: the user would watch a build think in gaps.

for (const innocent of [
  "I'll add a <Tool> component to the sidebar.",
  "The tool name is read_file and it takes a path.",
  "export function toolCall(name: string) { return name; }",
  "Use the tool_code column in the audit table.",
  "<ToolName name=\"x\" /> is a React element, not a tool call.",
  "a < b && c > d",
]) {
  check(`untouched: ${innocent.slice(0, 34)}…`, stripPseudoToolMarkup(innocent).text === innocent && !hasPseudoToolMarkup(innocent));
}

// ── Streaming: a marker split across chunks ──────────────────────────────────
// Text arrives in arbitrary slices, so `<tool_c` can end one chunk and `ode>`
// start the next. Emitting the first half and filtering the second would show
// the user half a tag.

{
  const filter = new PseudoToolFilter();
  let shown = "";
  for (const chunk of ["Building. <tool_c", "ode><tool name=\"fs_list\">", "</tool></tool_code> Done."]) {
    shown += filter.push(chunk);
  }
  shown += filter.flush();
  check("a marker split across chunks never shows", !shown.includes("tool_code") && !shown.includes("fs_list"));
  check("the surrounding prose still streams", shown.includes("Building.") && shown.includes("Done."));
  check("the attempted name is still captured", filter.names().includes("fs_list"));
}

{
  // Opened and never closed. There is nothing in an unterminated region for a
  // person to read, so the honest answer is to show none of it.
  const filter = new PseudoToolFilter();
  const shown = filter.push("Thinking. <tool_code>\n<tool name=\"x\">") + filter.flush();
  check("an unterminated region is not shown", !shown.includes("tool_code") && !shown.includes("<tool name"));
  check("text before it is shown", shown.includes("Thinking."));
}

{
  // The normal case must be completely transparent — same text out as in.
  const filter = new PseudoToolFilter();
  const parts = ["I am going to ", "write App.tsx ", "and then check the page."];
  let shown = "";
  for (const p of parts) shown += filter.push(p);
  shown += filter.flush();
  check("ordinary streamed text passes through unchanged", shown === parts.join(""));
}

// ── Both doors into the user's chat ──────────────────────────────────────────

check(
  "the closing summary cannot carry it either",
  !extractBuildSummary(SHOPHUB).includes("filesystem_list_allowed_directories") &&
    extractBuildSummary(SHOPHUB).includes("Now building the store"),
);

{
  const handler = readFileSync(new URL("../src/agents/stream-handler.ts", import.meta.url), "utf8");
  check("the narration path is filtered", handler.includes("pseudoFilter.push(text)"));
  check("the reasoning path is filtered too", handler.includes("pseudoReasoning.push(chunk.reasoning)"));
  check("held-back text is released at the end", handler.includes("pseudoFilter.flush()"));
  check(
    "fullContent is NOT filtered — the parser and the replay must see what arrived",
    handler.includes("fullContent += text") && !handler.includes("fullContent += pseudo"),
  );
  check("the attempt is logged with its names", handler.includes("model TYPED tool calls instead of calling them"));
}

// ── A typed call is a lost round, and gets corrected once ────────────────────

{
  const dispatcher = readFileSync(new URL("../src/agents/dispatcher.ts", import.meta.url), "utf8");
  check("the loop corrects the model instead of ending there", dispatcher.includes("PSEUDO_TOOL_CORRECTION"));
  check("bounded to one correction per dispatch", dispatcher.includes("!pseudoCorrected"));
  check(
    "a round that typed markup AND wrote files is left alone",
    dispatcher.includes("!/```/.test(streamResult.content)"),
  );
  check("the attempt reaches the record", dispatcher.includes("pseudoToolCalls"));
}

check(
  "the correction names the real mechanism, not just the mistake",
  PSEUDO_TOOL_CORRECTION.includes("read_file") &&
    PSEUDO_TOOL_CORRECTION.includes("write_files") &&
    PSEUDO_TOOL_CORRECTION.includes("no filesystem_* tool"),
);

console.log(`\n${checks} pseudo-tool checks passed`);
