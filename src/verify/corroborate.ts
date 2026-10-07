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
