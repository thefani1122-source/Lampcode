/**
 * The splitter turns MiniMax M2/M2.5 inline think tags inside `content` into
 * reasoning chunks, holding back tag prefixes that straddle stream chunks.
 * Bedrock's OpenAI-compatible route serves raw output, so without this the
 * reasoning lands in the chat content (or nowhere) instead of the thinking row.
 */
import { ReasoningTagSplitter } from "../src/agents/reasoning-tag-splitter.js";
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), CLOSE = LT + String.fromCharCode(47);

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? "✔" : "✘"} ${name}`);
  if (!pass) console.log(`    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  if (!pass) process.exitCode = 1;
}

function run(chunks: string[]): Array<{ kind: string; text: string }> {
  const splitter = new ReasoningTagSplitter();
  const out = chunks.flatMap((chunk) => splitter.feed(chunk));
  return out.concat(splitter.flush()).filter((p) => p.text);
}

const kinds = (pieces: Array<{ kind: string; text: string }>) => pieces.map((p) => `${p.kind}:${p.text}`);

check("tags intact in one chunk", kinds(run(["abc<infer>quiet stuff</infer>xyz"])), [
  "content:abc",
  "reasoning:quiet stuff",
  "content:xyz",
]);

check("opening tag split across chunks", kinds(run(["abc<in", "fer>quiet", " stuff</in", "fer>xyz"])), [
  "content:abc",
  "reasoning:quiet",
  "reasoning: stuff",
  "content:xyz",
]);

check("self-closing opening tag with attributes (M2.5)", kinds(run(["<think/>reasoning</think>final"])), [
  "reasoning:reasoning",
  "content:final",
]);

check("tag-free content passes through, flush joins it", kinds(run(["just normal ", "content"])), [
  "content:just normal ",
  "content:content",
]);

check("a lone < that is not a tag stays content", kinds(run(["a < b and x<"])), [
  "content:a < b and x",
  "content:<",
]);

check("unterminated think block becomes reasoning", kinds(run(["pre<infer>never closed"])), [
  "content:pre",
  "reasoning:never closed",
]);

check("closing tag split at end of stream", kinds(run(["<infer>r</thi", ""])), ["reasoning:r"]);

check("several think blocks in one stream", kinds(run(["<infer>a</infer>mid<infer>b</infer>end"])), [
  "reasoning:a",
  "content:mid",
  "reasoning:b",
  "content:end",
]);

check("thought tag family", kinds(run(["a" + LT + "thought" + GT + "hmm" + CLOSE + "thought" + GT + "b"])), [
  "content:a",
  "reasoning:hmm",
  "content:b",
]);

check("bracket tag family", kinds(run(["x[REASONING]step[/REASONING]y"])), [
  "content:x",
  "reasoning:step",
  "content:y",
]);

check("bracket tag split across chunks", kinds(run(["q[RE", "ASONING]z[/RE", "ASONING]w"])), [
  "content:q",
  "reasoning:z",
  "content:w",
]);

console.log("All reasoning-tag-splitter cases passed.");
