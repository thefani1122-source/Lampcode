/**
 * Which passes are allowed to talk to the user.
 *
 * The acceptance, audit and review passes dispatch on the USER'S sessionId —
 * they have to, for cost attribution — so every token they streamed landed in
 * the chat as "thinking". Seen in production on 2026-10-14: a notes-app build
 * opened with
 *
 *     { "criteria": [ { "text": "User can create new notes", "kind": …
 *
 * in the THOUGHTS panel. That is the acceptance pass talking to the audit,
 * shown to the user as though the builder were reasoning out loud in JSON.
 *
 * Their results do reach the user — through `formatCriteriaForUser` and
 * `formatAuditForUser`, in the user's own words. The raw stream never should.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentStream } from "../src/agents/stream-handler.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

const dir = mkdtempSync(join(tmpdir(), "narration-"));

/** Records what reached the room, instead of a real socket server. */
function recorder() {
  const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];
  return {
    events,
    wsServer: {
      emitToRoom: (_room: string, event: string, data?: Record<string, unknown>) => {
        events.push({ event, data });
      },
    },
  };
}

async function* reasoningThenText() {
  yield { type: "reasoning", reasoning: "weighing the options" };
  yield { type: "content", content: 'I will plan the best approach. { "criteria": [ { "text": "User can create notes" } ] }' };
  yield { type: "done", inputTokens: 1, outputTokens: 1 };
}

async function* proseThenText() {
  yield { type: "reasoning", reasoning: "tracing the failure" };
  yield { type: "content", content: "Found the bug in the router.\n\nFixing the guard now, then I will write the tests." };
  yield { type: "done", inputTokens: 1, outputTokens: 1 };
}

async function narrationFor(agentType: string): Promise<number> {
  const { events, wsServer } = recorder();
  await handleAgentStream(reasoningThenText() as never, {
    sessionId: "s1",
    agentType,
    taskId: "t1",
    outputPath: join(dir, `${agentType}.txt`),
    wsServer: wsServer as never,
  });
  return events.filter((e) => e.event === "build:thinking" || e.event === "build:token").length;
}

// Every pass that produces structured data for the system rather than prose
// for a person.
//
// `planning` was on the other list until 2026-10-23, on the grounds that it is
// part of the build rather than plumbing. True about its role and wrong about
// its OUTPUT: its prompt says "Output ONLY this JSON object", so narrating it
// put a raw plan object in the chat — the identical failure the acceptance
// pass caused, and the reason this file exists. It went unnoticed while
// planning ran on a minority of builds; making every build plan put it in
// front of every user at once. The pass still reports itself to the user, as
// "Planning the file layout…" and then the plan's summary.
for (const agentType of ["acceptance", "audit", "review", "planning"]) {
  check(`${agentType} narrates nothing to the user`, await narrationFor(agentType), 0);
}

// The build agent reports a concise, typed phase AND streams its provider
// reasoning to the chat (2026-10-31): the thinking row shows what the model
// is weighing, the way Claude Code does. Pre-code planning prose in `content`
// (the criteria JSON) is still not progress and stays out of the chat.
for (const agentType of ["frontend", "backend", "fix"]) {
  const { events, wsServer } = recorder();
  await handleAgentStream(reasoningThenText() as never, {
    sessionId: "s1",
    agentType,
    taskId: "t1",
    outputPath: join(dir, `${agentType}-build.txt`),
    wsServer: wsServer as never,
  });
  const thinking = events.filter((event) => event.event === "build:thinking");
  const internalPhase = thinking.find((event) => event.data?.internal === true);
  const reasoningDelta = thinking.find(
    (event) => event.data?.internal === false && event.data?.text === "weighing the options",
  );
  check(`${agentType} still emits the structured phase`, internalPhase?.data?.text, "Understanding your request");
  check(`${agentType} streams provider reasoning to the chat`, reasoningDelta !== undefined, true);
  check(
    `${agentType} does not expose planning prose as progress`,
    events.some((event) => JSON.stringify(event.data).includes("criteria")),
    false,
  );
}

// build:message (2026-11): the builder's own sentences between tool rounds
// stream to the chat the way Lovable narrates — prose outside the code
// fences only, closed with a done event, and a structured plan object in
// `content` still never reaches it. The emission is buffered to sentences and
// guarded by `looksStructured`; these cases pin both halves of that contract.
{
  const { events, wsServer } = recorder();
  await handleAgentStream(proseThenText() as never, {
    sessionId: "s1",
    agentType: "frontend",
    taskId: "t1",
    outputPath: join(dir, "prose-build.txt"),
    wsServer: wsServer as never,
  });
  const messages = events.filter((e) => e.event === "build:message");
  const text = messages.map((m) => (m.data?.text as string) ?? "").join("");
  check("builder prose streams to the user as build:message", text.includes("Found the bug in the router."), true);
  check("the streamed prose carries no code fences", text.includes("```"), false);
  check("the streamed prose message closes with done", messages.some((m) => m.data?.done === true), true);
}
{
  const { events, wsServer } = recorder();
  await handleAgentStream(reasoningThenText() as never, {
    sessionId: "s1",
    agentType: "frontend",
    taskId: "t1",
    outputPath: join(dir, "structured-build.txt"),
    wsServer: wsServer as never,
  });
  const leaked = events
    .filter((e) => e.event === "build:message")
    .map((m) => (m.data?.text as string) ?? "")
    .join("")
    .includes("criteria");
  check("a structured plan object never reaches build:message", leaked, false);
}

// The guard that would have caught this: a pass told to answer in JSON must
// never be on the narrating list. Both facts live in source, so they are
// checked against each other rather than trusted.
{
  const handler = readFileSync("src/agents/stream-handler.ts", "utf8");
  const prompts = readFileSync("src/agents/prompt-builder.ts", "utf8");
  const silent = /SILENT_AGENT_TYPES = new Set\(\[([^\]]+)\]\)/.exec(handler)?.[1] ?? "";
  for (const agentType of ["planning", "acceptance", "audit"]) {
    const asksForJson = new RegExp(`${agentType}:\\s*\`[\\s\\S]{0,4000}?Output ONLY this JSON`).test(prompts);
    check(
      `${agentType} asks for JSON, so it must be silent`,
      !asksForJson || silent.includes(`"${agentType}"`),
      true,
    );
  }
}

console.log(failures === 0 ? "\nAll narration cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
