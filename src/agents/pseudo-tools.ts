/**
 * Tool calls the model TYPED instead of making.
 *
 * MEASURED 2026-10-18, a real build (ShopHub). The model's visible reasoning
 * contained, verbatim:
 *
 *     <tool_code>
 *     <tool name="filesystem_list_allowed_directories">
 *
 * `filesystem_list_allowed_directories` is not one of this product's tools and
 * never was. Nothing executed — `executeTool` would have answered
 * `Error: unknown tool` — because the model never made a tool call at all. It
 * wrote the *syntax* of one, as prose, in a shape it learned from some other
 * harness, and prose is streamed to the user's chat verbatim by
 * `stream-handler`. So a person watching their app being built was shown an
 * XML fragment naming a filesystem tool, as though the builder were reasoning
 * about their machine.
 *
 * Stripping the string in the UI would have been the wrong fix twice over: the
 * text also stays in `content`, which `extractBuildSummary` turns into the
 * final message, and a model that is typing tool calls is a model that is NOT
 * calling tools — that is a lost round, not a rendering bug. So this module is
 * used in three places:
 *
 *   1. the narration path, so the markup never reaches a person;
 *   2. the summary path, so it can never land in the closing message;
 *   3. the dispatch loop, which counts it, logs the names, and tells the model
 *      once how tools actually work here.
 *
 * The patterns are deliberately narrow. Every opener below is a syntax marker
 * from a real harness, not a shape that occurs in prose or in TypeScript — a
 * generous pattern here would eat a sentence about a `<Tool>` component.
 */

/** An opener, its closer, and how to read the attempted tool's name. */
type PseudoPattern = {
  /** Must be anchored-free (used with a global flag) and specific. */
  open: RegExp;
  /** Literal closing tag, or null when the opener is self-contained. */
  close: string | null;
};

const PATTERNS: readonly PseudoPattern[] = [
  // Gemini / Vertex style: a code-ish block wrapping pseudo tool XML.
  { open: /<tool_code>/i, close: "</tool_code>" },
  // The one seen in production, which can also appear on its own.
  { open: /<tool\s+name\s*=\s*["'][^"']*["']\s*\/?>/i, close: "</tool>" },
  // Anthropic-shaped text, typed rather than emitted as blocks.
  { open: /<(?:antml:)?function_calls>/i, close: "</function_calls>" },
  { open: /<(?:antml:)?invoke\s+name\s*=\s*["'][^"']*["']\s*>/i, close: "</invoke>" },
  // OpenAI-ish and Qwen-ish variants.
  { open: /<tool_call>/i, close: "</tool_call>" },
  { open: /<\|tool_call\|>/i, close: null },
  { open: /\[TOOL_CALL\]/i, close: "[/TOOL_CALL]" },
];

/** Every name-bearing shape, for the log and for the correction. */
const NAME_RES: readonly RegExp[] = [
  /<tool\s+name\s*=\s*["']([^"']+)["']/gi,
  /<(?:antml:)?invoke\s+name\s*=\s*["']([^"']+)["']/gi,
  /\bfunctions\.([A-Za-z0-9_]+)\s*\(/g,
  /"(?:name|tool_name)"\s*:\s*"([A-Za-z0-9_.-]+)"/g,
];

/**
 * The longest opener prefix that could still be completed by a later chunk.
 *
 * Streamed text arrives in arbitrary slices, so `<tool_c` can be the end of one
 * chunk and `ode>` the start of the next. Emitting the first half and then
 * filtering the second would show the user half a tag — so the filter holds
 * back any tail that is a prefix of something it would strip.
 */
const MAX_HOLDBACK = 24;

function holdbackLength(buffer: string): number {
  const starts = ["<tool_code>", "<tool ", "<function_calls>", "<function_calls>", "<invoke ", "<invoke ", "<tool_call>", "<|tool_call|>", "[TOOL_CALL]"];
  const tail = buffer.slice(-MAX_HOLDBACK).toLowerCase();
  for (let i = Math.max(0, tail.length - 1); i >= 0; i--) {
    const candidate = tail.slice(i);
    if (candidate.length === 0) continue;
    if (starts.some((s) => s.startsWith(candidate))) return candidate.length;
  }
  return 0;
}

/** Names the text tried to call, deduped, in first-seen order. */
export function pseudoToolNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of NAME_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Remove every pseudo-tool region from a complete string.
 *
 * An UNCLOSED region runs to the end of the input on purpose. A model that
 * opened `<tool_code>` and then stopped has produced nothing a person should
 * read, and the alternative — showing the tail because the closer is missing —
 * is how the production leak looked in the first place.
 */
export function stripPseudoToolMarkup(text: string): { text: string; names: string[] } {
  if (typeof text !== "string" || text === "") return { text: "", names: [] };

  const names = pseudoToolNames(text);
  let out = text;

  // Repeat until stable: one region can contain another (a <tool_code> block
  // wrapping a <tool name=…> element is exactly the production case).
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const { open, close } of PATTERNS) {
      const re = new RegExp(open.source, open.flags.includes("i") ? "i" : "");
      const m = re.exec(out);
      if (!m || m.index === undefined) continue;

      const start = m.index;
      let end: number;
      if (close === null) {
        end = start + m[0].length;
      } else {
        const closeAt = out.toLowerCase().indexOf(close.toLowerCase(), start + m[0].length);
        end = closeAt === -1 ? out.length : closeAt + close.length;
      }
      out = out.slice(0, start) + out.slice(end);
      changed = true;
    }
    if (!changed) break;
  }

  return { text: out, names };
}

/** True when the text contains a typed tool call. */
export function hasPseudoToolMarkup(text: string): boolean {
  return PATTERNS.some(({ open }) => new RegExp(open.source, "i").test(text));
}

/**
 * Streaming filter: feed it chunks, emit what is safe to show.
 *
 * `push` returns the sanitized text that may be shown NOW, holding back both
 * an open region and any partial opener. `flush` returns whatever is left once
 * the stream has ended, which is empty when the model left a region open.
 */
export class PseudoToolFilter {
  private buffer = "";
  private readonly seen = new Set<string>();

  push(text: string): string {
    if (!text) return "";
    this.buffer += text;

    for (const name of pseudoToolNames(this.buffer)) this.seen.add(name);

    // An open region with no closer yet: hold everything from the opener and
    // release only what came before it.
    const openerAt = this.firstOpenRegion();
    if (openerAt !== null) {
      const head = this.buffer.slice(0, openerAt);
      this.buffer = this.buffer.slice(openerAt);
      return head;
    }

    const cleaned = stripPseudoToolMarkup(this.buffer).text;
    const hold = holdbackLength(cleaned);
    const emit = hold === 0 ? cleaned : cleaned.slice(0, cleaned.length - hold);
    this.buffer = hold === 0 ? "" : cleaned.slice(cleaned.length - hold);
    return emit;
  }

  /**
   * Index of an opener whose closer has not arrived, or null. A self-closing
   * opener is never "open", so it is stripped by push's normal path.
   */
  private firstOpenRegion(): number | null {
    let earliest: number | null = null;
    for (const { open, close } of PATTERNS) {
      if (close === null) continue;
      const m = new RegExp(open.source, "i").exec(this.buffer);
      if (!m || m.index === undefined) continue;
      const closeAt = this.buffer.toLowerCase().indexOf(close.toLowerCase(), m.index + m[0].length);
      if (closeAt !== -1) continue;
      if (earliest === null || m.index < earliest) earliest = m.index;
    }
    return earliest;
  }

  /** Whatever is safe to show after the stream ended. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    if (this.firstOpenRegionIn(rest) !== null) {
      // Opened and never closed — nothing in here is for a person to read.
      return stripPseudoToolMarkup(rest).text;
    }
    const cleaned = stripPseudoToolMarkup(rest).text;
    return cleaned;
  }

  private firstOpenRegionIn(text: string): number | null {
    for (const { open, close } of PATTERNS) {
      if (close === null) continue;
      const m = new RegExp(open.source, "i").exec(text);
      if (!m || m.index === undefined) continue;
      if (text.toLowerCase().indexOf(close.toLowerCase(), m.index + m[0].length) === -1) return m.index;
    }
    return null;
  }

  /** Every name this stream tried to call in text. */
  names(): string[] {
    return [...this.seen];
  }
}

/**
 * What the model is told, once, after it types a tool call instead of making
 * one. Exported so its wording is covered by a case.
 *
 * It names the mechanism rather than scolding: the observed failure was a
 * model reaching for another harness's syntax, which means it believed it had
 * tools it does not have and did not use the ones it does.
 */
export const PSEUDO_TOOL_CORRECTION =
  "You just wrote tool-call syntax as plain text instead of calling a tool. " +
  "Text like <tool_code>, <tool name=\"…\">, <invoke name=\"…\"> or [TOOL_CALL] does nothing here — " +
  "it is shown to the user as if it were your reasoning, and no tool runs.\n" +
  "Call tools through the API's own tool-call mechanism, and only the tools you were given in this request. " +
  "There is no filesystem server and no filesystem_* tool: read files with read_file, " +
  "list them with list_files, search with search_code, and write with write_files or edit_file.";
