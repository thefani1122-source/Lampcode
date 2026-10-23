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
  const events: string[] = [];
  return {
    events,
    wsServer: {
      emitToRoom: (_room: string, event: string) => {
        events.push(event);
      },
    },
  };
}

async function* reasoningThenText() {
  yield { type: "reasoning", reasoning: "weighing the options" };
  yield { type: "content", text: '{ "criteria": [ { "text": "User can create notes" } ] }' };
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
  return events.filter((e) => e === "build:thinking" || e === "build:token").length;
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

// The build agent itself. This must keep narrating — silencing everything would
// leave the user staring at an empty panel for the length of a build, which is
// the opposite failure and a worse one.
for (const agentType of ["frontend", "backend", "fix"]) {
  const count = await narrationFor(agentType);
  check(`${agentType} still narrates`, count > 0, true);
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
