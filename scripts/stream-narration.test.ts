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

import { mkdtempSync } from "node:fs";
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

// The three that produce structured data for the system.
for (const agentType of ["acceptance", "audit", "review"]) {
  check(`${agentType} narrates nothing to the user`, await narrationFor(agentType), 0);
}

// The build agent itself. This must keep narrating — silencing everything would
// leave the user staring at an empty panel for the length of a build, which is
// the opposite failure and a worse one.
for (const agentType of ["frontend", "backend", "fix", "planning"]) {
  const count = await narrationFor(agentType);
  check(`${agentType} still narrates`, count > 0, true);
}

console.log(failures === 0 ? "\nAll narration cases passed." : `\n${failures} case(s) failed.`);
if (failures > 0) process.exit(1);
