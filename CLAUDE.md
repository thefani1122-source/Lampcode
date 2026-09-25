# Lampcode — Project Context
Commit this file at the repo root. Claude Code reads it automatically every session.
## What this product is
Lampcode is an AI vibe-coding platform: a user types a natural-language prompt and gets a
working full-stack web app with a live preview. Competitors: Lovable, Bolt, Replit.
This repo (`Lampcode`) is the **backend**. The frontend lives in a separate repo
(`vibe-coder-suite`).
## Actual stack — VERIFIED, trust this over any skill file
| Layer | Reality | Evidence |
|---|---|---|
| Backend runtime | **Node ≥20.18.1** — NOT Bun | `package.json` `engines.node`, `start: node dist/index.js`, `@hono/node-server` |
| Backend framework | Hono | `src/server/index.ts` |
| Build | tsup → `dist/` | `tsup.config.ts` |
| Deploy | Railway (nixpacks) | `railway.toml` |
| LLM | **Claude Sonnet 5 via Anthropic direct API** (Bedrock path removed) | `src/agents/model-gateway.ts:217-218` |
| Gateway facade | `src/agents/model-gateway.ts`'s `ModelGateway.stream()` — Anthropic-direct, or `streamWithMcp()` when `mcpServers` is set | `model-gateway.ts:153,223` |
| Sandbox | E2B **v2 SDK** template `lampcode-vite` | `e2b-template/template.ts` + `build.ts` |
| Sandbox state | Redis, key `e2b:sandbox:{projectId}` | `src/preview/e2b-service.ts` |
| DB | Supabase Postgres + Drizzle | `src/db/schema.ts` |
| Realtime | Socket.IO | `src/websocket/server.ts` |
| Frontend repo | React 19 + Vite + TanStack Router, Bun as package manager | `vibe-coder-suite/vite.config.ts`, `bun.lock` |
### ⚠️ `.claude/skills/vibe-coder-architecture/SKILL.md` is STALE
It claims Bun runtime, Claude Sonnet 4.5, and TanStack Start SSR. All three are wrong for the
current code. When it conflicts with this file, **this file wins**. Fixing that skill is a
pending task.
`.claude/skills/sandbox-lifecycle/SKILL.md` is accurate — follow it for anything sandbox-related.
## Architecture map
```
User prompt
  → build.ts:runFastBuild()          orchestrates the whole build
  → prompt-builder.ts                assembles system prompt + conditional skills
  → dispatcher.ts → model-gateway.ts                (Sonnet 5, Anthropic direct)
  → file-parser.ts                   parses ```filename:path fences out of model output
  → e2b-service.ts                   writes files into sandbox, starts Vite (:5173)
                                     and backend (:3001 — tsx for Node, uvicorn for Python)
  → verifyPreview() → agentic fix loop
```
`src/deploy/pipeline.ts` used to be listed here as the deploy step. It is **dead code** — no
live call path reaches it. Do not describe deploy as working on the strength of that file.
### Key files
Line counts drift — re-check with `wc -l` before quoting them. Last measured 2026-09-25.

| File | Lines | Role |
|---|---|---|
| `src/server/routes/build.ts` | 2765 | Build orchestration, gates, fix loops |
| `src/agents/prompt-builder.ts` | 1817 | All prompt construction + skill loading |
| `src/preview/e2b-service.ts` | 1336 | Sandbox lifecycle + agent observation reads |
| `src/agents/file-parser.ts` | 603 | Fence → file extraction |
| `src/agents/tools.ts` | 514 | Tool definitions + execution (incl. the agentic build tools) |
| `src/agents/model-gateway.ts` | 491 | Model tiers, routing, tool-calling, prompt-cache splitting |
| `src/verify/security.ts` | 448 | Security checks — wired into `build.ts`'s hard-block/auto-fix loop |
| `src/agents/modal-gateway.ts` | 310 | OpenAI-compatible gateway (badly named — see below) |
| `src/billing/paddle.ts` | 267 | Paddle subscription + top-up application logic, webhook idempotency |
| `e2b-template/template.ts` | — | Authoritative sandbox definition (55 npm + 9 pip packages) |

## Two build architectures live side by side — READ THIS FIRST
As of 2026-09-25 there are two paths through `runFastBuild`, chosen by one flag.

**Pipeline (default, `AGENTIC_BUILD_ENABLED` unset/false).** One generation dispatch, then
six hardcoded repair loops (missing-files, entry-point, security, verifyPreview, typecheck,
browser-render — each capped at ~2 attempts). The model emits ```filename fences, never sees
the result of its own work, and every repair is `build.ts` noticing a problem and calling the
model back with a narrow prompt. This is the path that shipped, and the one the owner wants
gone — it is the reason the styling bug survived 3 months (no gate existed for "page renders
unstyled") and the reason a parser bug surfaced as "The AI did not produce a valid App.tsx".

**Harness (`AGENTIC_BUILD_ENABLED=true`).** The model gets sandbox tools and drives:
`write_files`, `list_files`, `read_file`, `read_logs`, `check_page`, `check_types`. Turn count
bounded by `AGENTIC_MAX_TURNS` (default 12); the real budget bound is the in-loop `costGuard`.
Runs for new builds AND edits, on Anthropic or any OpenAI-compatible provider. Files come back
via `DispatchResult.generatedFiles` instead of fence parsing, so every downstream gate is
unchanged.

**The plan: delete the pipeline once the harness is proven, not before.** Agreed order —
harness must handle edits (done), then be exercised on real builds (NOT done), then the
pipeline goes. Deleting first leaves no fallback for a thing that has never run once.

### Provider config — the env names lie, and it has already caused confusion
`modal-gateway.ts` is **not Modal-specific**. It speaks any OpenAI-compatible
`/v1/chat/completions` endpoint. Preferred env names are `LLM_ENDPOINT_URL`, `LLM_API_KEY`,
`LLM_MODEL_NAME`; the older `MODAL_ENDPOINT_URL` / `MODAL_PROXY_TOKEN` / `MODAL_MODEL_NAME`
still work as a fallback. The gateway appends `/v1/chat/completions` itself, so the URL must
NOT end in `/v1`.

`MODAL_REASONING_EFFORT` (default `low`) exists because GLM-5.3 forces reasoning on and at
default effort spent the entire token budget thinking, never reaching code. It is not a
standard OpenAI field — set it to `off` for any model that doesn't accept it.

**Free tier routes to this gateway, paid tier to Anthropic** (`build.ts`, `getUserPlan`).
Both run the same architecture — that is deliberate. Do not reintroduce a provider-specific
build path: a project built on the free plan must keep behaving the same after an upgrade.

Modal now offers **Shared Endpoints** (per-token, Modal-managed) carrying DeepSeek, GLM 5.3,
GLM 5.3 Flash, Kimi K3, Qwen and others — so Modal *can* serve Kimi, contrary to what
"Modal is compute, not a model provider" would suggest. Note: **Modal plan credits do not
apply to shared-endpoint usage.**
## Current state and what is NOT proven — 2026-09-25
The owner cannot top up Anthropic credits (card failures), is pre-launch, and is preparing a
LinkedIn launch. Keep this in mind: cost and "can this be tested at all" are real constraints,
not hypotheticals.

**Pre-launch waitlist is ON.** `WAITLIST_MODE` defaults to true. It blocks `/api/build/fast`
for non-admins, blocks `/paddle/config` for everyone (admins included — nobody gets billed
pre-launch), and the frontend shows a thank-you page instead of the product. Admins bypass the
frontend gate via `VITE_ADMIN_EMAILS` (mirrors backend `ADMIN_EMAILS`). Set
`WAITLIST_MODE=false` + `VITE_WAITLIST_MODE=false` to open the product.

**Nothing in the harness has run against a live build.** Everything is typecheck-clean and
verified by simulation only. Specifically unproven: whether any model holds a 12-turn tool
loop, whether `check_page` reports usefully mid-loop, and real cost per agentic build.
`MAX_BUILD_COST_USD` is still 1.0, which is probably too low for a harness build — expect to
raise it, deliberately, once there is a measurement.

**To actually test the harness:** set `LLM_*` (or `MODAL_*`) to a working OpenAI-compatible
endpoint, then `AGENTIC_BUILD_ENABLED=true` on Railway. Run one new build and one follow-up
edit. Watch for: did the model call `check_page` at all, did it repair anything, did the edit
preserve untouched files.

**Deferred on purpose:** JEV (`jevai.org`, TypeSafe AI) — a millisecond typed-decision model.
`jev_review_completion` is a genuinely good fit for the harness's worst failure mode (agent
declares "done" on a broken app) because it sits outside the agent's control. Not adopted yet:
the site is a community site with no published pricing, and its two doc pages disagree on the
request shape. Revisit after the harness is running and false "done" rates can be measured.

## Things that will bite you
1. **Two orphan Dockerfiles.** `/e2b.Dockerfile` and `/e2b-template/e2b.Dockerfile` are both
   legacy. The live template is built from `e2b-template/template.ts` via
   `Template.build()` in `e2b-template/build.ts`. Never edit the Dockerfiles expecting effect.
2. **Never generate `src/styles.css`.** It is pre-baked with Tailwind v4 design tokens.
   Overwriting it breaks every CSS variable. Same for `vite.config.ts`, `tsconfig.json`,
   `index.html` — the template owns them.
3. **No CMD in the template.** The backend starts Vite itself. A baked CMD causes the
   "double-Vite" port race.
4. **Prompt-vs-reality drift is the #1 bug class here.** The prompt hardcodes lists of allowed
   packages and supported runtimes that have drifted from what `template.ts` actually installs.
   When touching either, check the other.
5. **Python path is real and works.** `template.ts:278` installs fastapi, uvicorn, supabase,
   crewai, langgraph, langchain-anthropic, apscheduler, exa-py. `e2b-service.ts:519-556` detects
   the runtime and runs `uvicorn main:app --port 3001`. Do not remove this — it is a user-facing
   feature for building AI agents and automations. (AutoGen is NOT installed and never was.)
## Working rules
Follow `.claude/skills/investigate-confirm-fix` — it is the required methodology here:
1. **Investigate first.** Read the actual current file contents. Do not act on assumptions or on
   what a task description claims. Files change between sessions.
2. **Report and wait.** Present findings, root cause, exact change plan, and risks. Stop for
   approval before editing.
3. **Change only what was approved.** No drive-by refactors, no opportunistic cleanup, no
   renaming. Prefer surgical edits over full-file rewrites.
4. **Verify.** Run `npm run typecheck` (`tsc --noEmit`). Target zero NEW errors; note
   pre-existing ones separately. Report per-change status honestly, including anything you
   could not verify.
**A correct no-op is a success.** If investigation shows a reported bug does not exist or was
already fixed, say so and change nothing.
**Never claim something is done when a step remains** (merge, env var, redeploy, untested path).
State the remaining step explicitly.
## Commands
```bash
npm run dev         # tsx watch, loads .env
npm run build       # tsup → dist/
npm run typecheck   # tsc --noEmit
npm run db:generate # drizzle-kit generate
```
There is no test suite (`npm test` exits 1). `tsc --noEmit` is the verification gate.
