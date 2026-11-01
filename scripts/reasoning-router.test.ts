/**
 * The router is the single classifier of a model's stream: provider reasoning
 * fields, think tags inside content (any supported tag family, split across
 * chunks), stats, and the raw-turn reconstruction used for conversation
 * history. These tests pin each of those jobs.
 */
import type { StreamChunk } from "../src/agents/model-gateway.js";
import { ReasoningRouter } from "../src/agents/reasoning-router.js";
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const CLOSE_THINK = LT + String.fromCharCode(47) + "think" + GT

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? "✔" : "✘"} ${name}`);
  if (!pass) console.log(`    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  if (!pass) process.exitCode = 1;
}

const content = (text: string): StreamChunk => ({ type: "content", content: text });
const fieldReasoning = (text: string): StreamChunk => ({ type: "reasoning", reasoning: text });

function run(chunks: StreamChunk[]): { pieces: Array<{ kind: string; text: string }>; router: ReasoningRouter } {
  const router = new ReasoningRouter();
  const pieces = chunks
    .flatMap((c) => router.feed(c))
    .concat(router.flush())
    .filter((p) => p.text);
  return { pieces, router };
}

const kinds = (pieces: Array<{ kind: string; text: string }>) => pieces.map((p) => `${p.kind}:${p.text}`);

// ── Provider reasoning field ────────────────────────────────────────────────
{
  const { pieces, router } = run([fieldReasoning("plan the file layout"), content("<html>done</html>")]);
  check("field reasoning passes through as reasoning", kinds(pieces), [
    "reasoning:plan the file layout",
    "content:<html>done</html>",
  ]);
  check("stats attribute field reasoning", { ...router.stats(), firstSample: "" }, {
    reasoningChunks: 1,
    reasoningChars: "plan the file layout".length,
    contentChars: 17,
    via: "field",
    firstSample: "",
  });
}

// ── Think tags inside content (the MiniMax M2/M2.5 shape) ───────────────────
{
  const { pieces, router } = run([content("abc" + LT + "think" + GT + "quiet stuff" + CLOSE_THINK + "xyz")]);
  check("think tags split out of content", kinds(pieces), [
    "content:abc",
    "reasoning:quiet stuff",
    "content:xyz",
  ]);
  check("stats attribute tag reasoning", { ...router.stats(), firstSample: "" }, {
    reasoningChunks: 1,
    reasoningChars: "quiet stuff".length,
    contentChars: 6,
    via: "tags",
    firstSample: "",
  });
  check("historyText rebuilds the raw turn", router.historyText(), "abc" + LT + "think" + GT + "quiet stuff" + CLOSE_THINK + "xyz");
}

// ── Tag split across stream chunks ──────────────────────────────────────────
{
  const { pieces } = run([content("abc<thi"), content("nk>quiet"), content("</thi"), content("nk>xyz")]);
  check("tag spanning four chunks still routes as reasoning", kinds(pieces), [
    "content:abc",
    "reasoning:quiet",
    "content:xyz",
  ]);
}

// ── Bracket tag family ──────────────────────────────────────────────────────
{
  const { pieces, router } = run([content("x[REASONING]step one[/REASONING]y")]);
  check("bracket reasoning tags split out", kinds(pieces), [
    "content:x",
    "reasoning:step one",
    "content:y",
  ]);
  check("bracket reasoning is preserved in history", router.historyText(), "x\u003Cthink\u003Estep one\u003C\u002Fthink\u003Ey");
}

// ── Both channels at once ───────────────────────────────────────────────────
{
  const { router } = run([fieldReasoning("why"), content("a" + LT + "think" + GT + "also" + CLOSE_THINK + "b")]);
  check("via reports both channels", router.stats().via, "field+tags");
}

// ── Field reasoning is NOT replayed into history ────────────────────────────
{
  const { router } = run([fieldReasoning("secret chain"), content("answer")]);
  check("field reasoning stays out of historyText", router.historyText(), "answer");
}

// ── Unclosed tag: everything after it is reasoning until the stream ends ────
{
  const { pieces } = run([content("a<think>never closed")]);
  check("unclosed tag flushes as reasoning", kinds(pieces), ["content:a", "reasoning:never closed"]);
}

// ── Plain content with no reasoning at all ──────────────────────────────────
{
  const { pieces, router } = run([content("just code"), content(" more code")]);
  check("plain content passes through untouched", kinds(pieces), ["content:just code", "content: more code"]);
  check("via reports none when nothing reasoned", router.stats().via, "none");
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall reasoning-router checks passed");
