# Outside research, checked against this codebase

One section per report the owner brings. Each one answers four questions in order:

1. **Is the claim true?** Checked against the primary source, not recalled. This repo's first
   working rule exists because confident outside claims have repeatedly been false here.
2. **What does it actually suggest for us?** Most of this research is about agents maintaining
   long-lived existing codebases. Lampcode generates new apps for people who do not write code.
   Some lessons transfer directly, some transform, some do not apply at all — and saying which
   is the work.
3. **Where do we actually stand?** Measured against the real files, not assumed.
4. **What would production-level implementation mean?** Not "add a plugin system" — the concrete
   seam, its cost, and what it breaks.

`HISTORY.md` holds what we measured ourselves. This file holds what others claim and what it is
worth to us.

---

## REPORT 1 — DeepSeek Harness: "everything is a plugin" — 2026-10-15

### 1. Verified

Fetched `docs/architecture.md` and `README.md` from the repository directly. **The report's
reading is accurate.** That is worth saying plainly, because it is not the usual outcome here.

Confirmed verbatim from the architecture document:

- *"Every part of the product is a plugin, including the model adapter, the tool registry, the
  session log, and the agent loop itself, so each is replaceable from configuration."*
- *"There is no privileged core to patch: you extend dsh by mounting a plugin beside the
  others."*
- *"Events are the extension points, and picking the right domain is the first decision in most
  changes."* — three domains: **session** (durable, survives reload), **agent** (live, intercept
  work in flight), **capability** (attach policy/adapters to a seam without importing the loop).
- *"**Model-visible means logged.** Every model request must be reconstructable from the log."*
- A **seam** has exactly three roles — Service Definition, Service Provider, Consumer — and
  *"one role alone is not a seam; adding a capability means designing all three."*
- *"Seams are why one provider swap changes the whole product. Filesystem and subprocess
  providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and
  LSP with them, with no provider forks."*

The turn flow in the document matches the report's shape: `agent/pre-step` → `agent/request` →
`tools/pre-execute` → `tools/execute` → `tools/post-execute` → `agent/turn-stopping`. Four of
those are **waterfalls** whose listeners must call `next()` to delegate — so a listener can
rewrite, reject or short-circuit. That is a stronger mechanism than the report conveys: it is
not only observation, it is interception.

Also confirmed: MIT licence, built on Cordis (`arxiv.org/abs/2608.25512`).

### 2. What the report overstates, or did not verify

- **"DeepSeek's recent direction even allows Claude Code/Codex-oriented bundles."** Not
  supported by the architecture document. It documents `web`, `headless`, `sdk`, `sdk-minimal`
  and `acp` profiles — `acp` being an automation server, not a Claude Code bundle. The strategic
  point the report draws from it (point 5, Lampcode orchestrating other agents) may still be
  right, but **this source does not establish it** and it should not be cited as if it does.
- **The cost of the abstraction is much larger than the report implies.** The report lists
  "abstraction, dependency management, lifecycle complexity" as a caveat. The actual document
  additionally requires: profiles, bundles, ordered patch layers, `cordis.patch.yml`, HMR
  coordination, isolate realms, session format generations with per-version migration packages,
  mandatory projection seams, and an entrypoint verifier script that rejects any Node path
  bypassing `dsh`. This is a framework, not a pattern.
- **Stability, confirmed from the README:** *"DeepSeek Harness is in developer preview and
  iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"* The report mentions
  this; it deserves more weight than it was given. We cannot depend on it, and copying an
  architecture that is itself unstable buys instability twice.

### 3. Where Lampcode actually stands — measured today, not assumed

| Seam | Reality | Verdict |
|---|---|---|
| **Model adapter** | `dispatcher.ts:339` — `effectiveProvider: "anthropic" \| "modal"`, routing to `model-gateway.ts` / `modal-gateway.ts` | **A real seam already.** Binary rather than open, but the shape is right and it is the one thing we would not have to invent. |
| **Tool registry** | `executeTool` is **758 lines** with a **29-branch** `name === "…"` if-chain; definitions are two static arrays | **No seam.** Adding a capability means editing one enormous function. This is the worst of the five. |
| **Sandbox / execution** | `e2b-service.ts` imported DIRECTLY by **6 files** — `build.ts`, `tools.ts`, `build-planner.ts`, `server/index.ts`, `build-handler.ts`, `review-units.ts` | **No seam.** Every consumer knows the implementation. Trap 9 in CLAUDE.md — that importing it outside the server process hangs — is a *symptom* of exactly this: a capability welded to one provider that drags config, Redis and the E2B SDK in with it. |
| **Session / state** | A `build_sessions` row, a `build_outcome` jsonb written at the end, and Socket.IO emits that are not stored | **No seam, and no log.** There is no event stream and nothing is replayable. |
| **Agent loop** | Hardcoded in `dispatcher.ts:550`, `for (let round = 1; round <= maxRounds; round++)` | **No seam.** Not necessarily wrong — see below. |

### 4. What this is actually worth to us — ranked by evidence, not by elegance

**(a) The session event log is the one idea with measured evidence behind it in OUR data.**

This is not borrowed enthusiasm; we have already paid for its absence, three times over:

- 2026-10-14: a deploy landed mid-build, SIGTERM fired, and two builds were simply gone. The
  shutdown handler can only tell the user "nothing was saved — run it again", because there is
  nothing to resume from.
- 2026-10-14: `build_plan` is written by `build.ts` and **the column does not exist in
  production**. The `.catch()` logs a warning. The feature whose entire purpose is "the plan
  survives a build that does not finish" has never once worked, and nothing noticed, because
  there is no log that would have shown the write failing.
- 2026-10-15: `build_outcome` goes **stale** — `deadCode.orphanStylesheets` recorded 1 while the
  delivered files scanned clean, because `finishPreview`'s repair loops mutate `allFiles` after
  the record is written. A fact written once at the end cannot describe a process that continues
  afterwards. An append-only log does not have this failure mode at all.

DeepSeek's rule — *model-visible means logged* — would also have caught the RelayOps failure
faster: 5 rounds, 0 files, and the only way to find out what the model actually saw was to grep
Railway logs for a `<minimax:tool_call>` string.

**This is the lesson to take. Not the plugin system — the log.**

**(b) The tool registry seam is cheap, and we have a concrete reason to want it now.**

A 758-line function with a 29-branch if-chain is not an architecture argument, it is a
maintenance fact. And the list of tools we know we are missing for long projects — content
search, shell, delete, git — means four more branches in that function as things stand.

The minimal version is not Cordis. It is: a `ToolHandler` interface, a `Map<string, handler>`,
and each tool as its own module. No plugin loading, no config layers, no lifecycle. That is a
refactor with a clear end state, testable, and it makes every subsequent tool cheap.

**(c) The sandbox seam is real but should follow, not lead.**

Six direct importers is a genuine coupling problem and trap 9 is its scar. But we have exactly
one provider (E2B) and no concrete second one. Designing an interface with one implementation is
how you get the wrong interface. The honest sequencing: extract it **when** a second execution
target appears — the user's own machine, a Docker runner, or Vercel sandboxes — and let that
second case define the shape.

**(d) The agent loop should NOT be made pluggable, and this is where I disagree with the
report.**

DeepSeek makes the loop replaceable because it is a general-purpose harness serving many
products. Lampcode is one product with one loop. Making it pluggable would cost us the ability
to reason about it, and our measured failures are not in the loop's structure — they are in what
the loop can SEE (the render check) and what it is steered to do (5 rounds, 0 files). A seam
there solves nothing we have evidence for.

**(e) The capability-event idea has one immediate, concrete use.**

Not as a general bus. But `build.ts` at ~3,700 lines now contains the security loop, the orphan
loop, the wiring loop, the audit, the dead-code scan, the hollow-test scan and the interaction
probe, each as an inline block. Those are exactly the things DeepSeek would attach to
`tools/post-execute` and `agent/turn-stopping`. **The seam to want is not "events everywhere" —
it is one: a place where verification passes register themselves instead of being inlined.**

### 5. What production-level implementation means here

Not "add a plugin system". Concretely, and in this order:

**Step 1 — the session event log.** An append-only table, typed events, written as they happen:
`turn/start`, `tool/call`, `tool/result`, `verification/result`, `turn/end`. The existing
`build_outcome` becomes a projection derived from it rather than a thing written once at the
end. This fixes the staleness class permanently rather than one field at a time, makes the
RelayOps-style post-mortem a query instead of a log grep, and is the prerequisite for ever
resuming a build that a deploy killed.

Cost: a real migration — and note that the one migration this repo most recently needed,
`build_plan`, was never applied, which is itself a warning about how migrations happen here.
They are applied by hand. That has to be part of the plan, not an afterthought.

**Step 2 — the tool registry.** `Map<string, ToolHandler>`, one module per tool, and
`executeTool` becomes a lookup plus the shared guards. Delete, grep, shell and git then cost one
small file each instead of one more branch in a 758-line function.

**Step 3 — one verification seam.** The passes that currently sit inline in `build.ts` register
themselves. `build.ts` shrinks by what it no longer inlines.

**Not now:** sandbox interface (one provider), pluggable loop (no evidence), profiles/bundles/
patch layers (a framework we do not need), and anything requiring Cordis.

### 6. The sentence worth keeping

The report's own summary is the right one and survives verification:

> Don't build the smartest fixed coding agent. Build a system whose models, agents, tools and
> strategies can keep evolving while its engineering state, control and proof remain stable.

With one correction from the measurement above: for us, **"engineering state" is the part we do
not have.** Models are already swappable here. Tools are one refactor away. State is missing
entirely — and every one of the three failures in (a) is a state failure.
