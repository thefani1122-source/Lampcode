---
name: vibe-coder-architecture
description: How Lampcode's backend is actually built — Node + Hono, Claude Sonnet 5 or any OpenAI-compatible endpoint, the agentic build harness and its sandbox tools, and the two build paths through runFastBuild. Use when architecting, extending or debugging the build pipeline, the agent loop, prompt construction, or how generated code reaches the preview. For the sandbox layer specifically, use sandbox-lifecycle instead. CLAUDE.md at the repo root is authoritative over this file.
---

# Lampcode architecture — the real one

**CLAUDE.md at the repo root is the source of truth.** It is loaded every
session and is kept current. This file orients you; where the two disagree,
CLAUDE.md wins, and the disagreement is a bug in this file.

## What this file replaced, and why it matters

Until 2026-10-03 this skill was a 592-line "production blueprint" for a
different product. It described a **Bun** runtime with `Bun.serve` and
`bun.lockb`, a **TanStack Start SSR** frontend, **Claude Sonnet 4.5**, a
`start_cmd` baked into the E2B template, and Lovable's `<lov-cmd>` tag format.
Every one of those is wrong here — and one of them is the opposite of a rule
CLAUDE.md states explicitly ("No CMD in the template", because a baked start
command races the backend for port 5173).

It mattered because a skill is not documentation you choose to read. Its
description triggered on essentially any architectural question in this repo,
and 592 lines of a stack we do not run went into the context ahead of the facts.
Being out of date made it worse than absent.

So: short, pointed at CLAUDE.md, and easier to keep honest.

## The stack, verified

| Layer | Reality |
|---|---|
| Runtime | **Node ≥20.18.1** — not Bun. `start: node dist/index.js`, `@hono/node-server` |
| Framework | Hono (`src/server/index.ts`) |
| Build | tsup → `dist/` |
| Deploy | Railway (nixpacks) |
| LLM | **Claude Sonnet 5** via the Anthropic API, **or any OpenAI-compatible endpoint** (`modal-gateway.ts`). Chosen per plan: free → OpenAI-compatible, paid → Anthropic |
| Sandbox | E2B v2 SDK, template `lampcode-vite` (`e2b-template/template.ts`) |
| DB | Supabase Postgres + Drizzle (`src/db/schema.ts`) |
| Realtime | Socket.IO (`src/websocket/server.ts`) |
| Frontend | A separate repo, `vibe-coder-suite`: React 19 + Vite + TanStack **Router** (not Start) |

## Two paths through `runFastBuild`, chosen by one flag

**Harness (`AGENTIC_BUILD_ENABLED=true`).** The model is given sandbox tools and
drives its own loop: `write_files`, `edit_file`, `check_page`, `check_types`,
`run_tests`, `list_files`, `read_file`, `read_logs`, `fetch_reference`. Files come
back as `DispatchResult.generatedFiles`, so every downstream gate is unchanged.
Bounded by `AGENTIC_MAX_TURNS` and, as the real budget, the in-loop `costGuard`.
This is the path that works and the one being measured.

**Pipeline (the default when that flag is off).** One generation dispatch
emitting ```filename fences, then six hardcoded repair loops in `build.ts`. The
model never sees the result of its own work. This is the path that shipped, and
the one the owner wants gone — but not before the harness is proven, because
deleting it first leaves no fallback.

## The shape of a build

```
prompt
 → build-classifier.ts   does this need a server and a database?
 → build-planner.ts      for a new build of any size: a file-by-file plan
 → prompt-builder.ts     system prompt + conditional skills + the plan
 → dispatcher.ts         the tool loop; model-gateway.ts or modal-gateway.ts
 → tools.ts              the sandbox tools the model drives
 → e2b-service.ts        writes files, starts Vite (:5173) and the backend (:3001)
 → gates                 check_page / check_types / run_tests, recorded as build_outcome
```

`src/deploy/pipeline.ts` is **dead code** — no live call path reaches it. Do not
describe deploy as working on the strength of that file.

## Things to read before changing anything

- **CLAUDE.md** — current state, what is proven and what is not, and a list of
  things that will bite you. Start here, always.
- **`.claude/skills/sandbox-lifecycle/SKILL.md`** — accurate, and the right
  source for anything touching the sandbox, HMR or the preview iframe.
- **`.claude/skills/investigate-confirm-fix`** — the required methodology:
  investigate the real file contents first, report before editing, change only
  what was approved, verify with `npm run typecheck` and `npm test`.

## The failure mode this repo keeps hitting

Prompt-and-reality drift, in both directions. The build prompt hardcodes lists
of allowed packages and supported runtimes that drift from what `template.ts`
installs; a stale skill like the one this file replaced drifts from the code. The
expensive bugs here have nearly all been of that kind — something describing the
system confidently and wrongly, for weeks, with nothing failing loudly enough to
notice. When you touch the prompt, check the template. When you touch the
template, check the prompt. And read build logs to their last line.
