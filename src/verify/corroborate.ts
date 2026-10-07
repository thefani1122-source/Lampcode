/**
 * Checking a model's claim against something the model does not control.
 *
 * This was written inside the completion audit and is now shared, because the
 * review needs exactly the same guard and for exactly the same measured reason.
 * On 2026-10-07 the auditor reported, in confident detail, that a component
 * "only has export default", that its prop names disagreed, and that a function
 * was "never called anywhere in the app". All three were false. Nothing in the
 * pipeline could tell that verdict apart from a real one, and the user would
 * have been shown NOT DONE over working code.
 *
 * A review is worse exposed than an audit, because a review's entire output is
 * claims. So the rule is the same in both: a claim about code must quote the
 * line it is about, and the quote is looked up in the real file. A claim whose
 * quote is not there is not reported as a fact.
 *
 * Keeping one copy matters: if the two drifted, the weaker one would become the
 * way through. The same argument as `src/mcp/call-tool.ts` — a fix to one is a
 * fix to both.
 */

/** Shortest quote that can corroborate anything. Below this, `}` or `return`
 *  matches almost any file and the check becomes theatre. */
export const MIN_QUOTE_CHARS = 12;

/**
 * Split an evidence string into the bare paths it cites.
 *
 * Tolerates what models actually emit: `src/a.ts:42`, a leading `./`, several
 * separated by commas or semicolons, and a trailing `#symbol`.
 */
export function citations(evidence: string): string[] {
  return evidence
    .split(/[,;]/)
    .map((s) => s.trim().replace(/^\.?\//, "").split(/[:#\s]/)[0] ?? "")
    .filter((s) => s !== "");
}

/**
 * Collapse whitespace.
 *
 * A model retypes what it read and will not reproduce indentation or line
 * wrapping, so matching has to ignore both — otherwise the check rejects honest
 * claims and the whole mechanism is useless.
 */
export function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Is a symbol the claim says is MISSING really absent from the file it cites?
 *
 * This exists because of a measured gap. On the ROTA build, 2026-10-07, the
 * audit's seven non-proven verdicts were all the same true finding — App.tsx
 * imports none of the four views the user asked for, so the whole feature is
 * unreachable — and the quote rule DOWNGRADED four of them. Correctly, by its
 * own logic: they assert an absence, and **you cannot quote a line that is not
 * there.** So the rule was discarding exactly the class of finding that matters
 * most, because "X is missing" is what a forgotten requirement looks like.
 *
 * An absence is just as checkable as a presence, only inverted: the model names
 * the symbol it says is not in the file, and this confirms it really is not.
 * A model cannot fabricate an absence that the file contradicts.
 *
 * The symbol must look like an identifier. A sentence ("any routing for the
 * views") is not checkable and gets no credit — otherwise a model could
 * corroborate anything by describing it vaguely enough.
 */
export function symbolIsAbsentFromCitedFile(
  symbol: string,
  evidence: string,
  files: Record<string, string>,
): boolean {
  const name = symbol.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const known = new Set(Object.keys(files).map((p) => p.replace(/^\.?\//, "")));
  for (const cited of citations(evidence)) {
    if (!known.has(cited)) continue;
    const content = files[cited] ?? files[`./${cited}`] ?? "";
    // The file has to EXIST and not mention it. An unknown file proves nothing.
    if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Is this quote really in one of the files it cites?
 *
 * Deliberately strict about WHICH file: a quote found somewhere else in the
 * project does not corroborate a claim about this one. That is how a model
 * citing the wrong file gets caught rather than accidentally vindicated.
 */
export function quoteIsInCitedFile(
  quote: string,
  evidence: string,
  files: Record<string, string>,
): boolean {
  const needle = normaliseWhitespace(quote);
  if (needle.length < MIN_QUOTE_CHARS) return false;
  const known = new Set(Object.keys(files).map((p) => p.replace(/^\.?\//, "")));
  for (const cited of citations(evidence)) {
    if (!known.has(cited)) continue;
    const content = files[cited] ?? files[`./${cited}`] ?? "";
    if (normaliseWhitespace(content).includes(needle)) return true;
  }
  return false;
}
