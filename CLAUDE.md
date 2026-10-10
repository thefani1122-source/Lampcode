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
### Skills — both accurate as of 2026-10-03
`.claude/skills/vibe-coder-architecture/SKILL.md` was 592 lines describing a different product:
Bun runtime with `Bun.serve` and `bun.lockb`, TanStack Start SSR, Claude Sonnet 4.5, a
`start_cmd` baked into the E2B template (the exact opposite of the "No CMD in the template"
rule below), and Lovable's `<lov-cmd>` tag format. **Rewritten to 92 lines** that match the code
and point here. It mattered because a skill is not documentation you choose to read — its
description triggered on nearly any architectural question in this repo, so the wrong stack went
into the context ahead of the facts. When it conflicts with this file, **this file wins**.

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

## The harness is the default now — and "the pipeline" is NOT a separate block
**`AGENTIC_BUILD_ENABLED` defaults to TRUE as of 2026-10-03.** The flag remains as a kill
switch: set it to `"false"` and generation falls back to fence parsing. Justification is
measurement, not preference — 20 real builds across all three eval tiers, 20/20 built, 0 build
failures, 0 harness errors, the turn cap never reached, and the core tier 11/11 on every check.

**Harness (the default).** The model gets sandbox tools and drives: `write_files`, `edit_file`,
`list_files`, `read_file`, `read_logs`, `check_page`, `check_types`, `run_tests`,
`fetch_reference`. Turn count bounded by `AGENTIC_MAX_TURNS`; the real budget bound is the
in-loop `costGuard`. Runs for new builds AND edits, on Anthropic or any OpenAI-compatible
provider. Files come back via `DispatchResult.generatedFiles` instead of fence parsing, so
every downstream gate is unchanged.

### Correcting what this section used to say — the repair loops are SHARED
This file previously described "six hardcoded repair loops" as belonging to the pipeline, and
the agreed plan as deleting them once the harness was proven. **That description was wrong, and
acting on it would have deleted working defence code.** Verified against `build.ts` on
2026-10-03 — `agenticBuild` appears at exactly seven lines (943, 944, 1127, 1214, 1282, 1362,
1735), and NONE of the repair loops is among them. They are bare blocks that run on both paths,
gated on the build's shape rather than on the flag:

| loop | line | gated on |
|---|---|---|
| missing fullstack files (one focused retry) | ~1439 | `isFullstackBuild` |
| entry point present for a new build | ~1406 | new build, not the flag |
| syntax + orphan-export | 1560 | nothing — always |
| security | 1942 | nothing — always |
| `verifyPreview` / backend crash | 2240 | nothing — always |
| typecheck | 2316 | nothing — always |
| browser render | 2428 | nothing — always |

So an agentic build already runs all of them, after the agent has finished. They are a second,
deterministic layer under the agent's own gates — and Finding 4 (`editor-undo` passed
`check_page`, `check_types` and its own tests while shipping no persistence at all) is the
standing evidence that the agent's self-assessment is not sufficient on its own.

Only ONE thing is actually pipeline-only: the Sandpack file validation at line 1735, skipped
for agentic builds because it asserts the model wrote `index.tsx` and `package.json`, which the
template owns.

**And the fence-parsing fallback at 1282 protects the AGENTIC path**, which is the opposite of
how it reads from the old description. Its own comment: a model that ignores the write-files
instruction "still writes perfectly good code, just in its reply", and reading only
`generatedFiles` "threw all of it away and reported 'generation failed' over a build that had
produced a whole app". Deleting it reintroduces a fixed bug.

What a real removal would therefore be: not one excision, but retiring the deterministic layer
loop by loop, each one only once the eval shows the agent's own gates catch what it caught. The
`check_types`-called-on-3-of-10 gap and Finding 4 both say that day has not arrived. Nothing
here is scheduled for deletion.

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

**How Modal Shared Endpoints are actually addressed** (from Modal's own docs — this is not
guessable and getting it wrong looks exactly like a broken model):
- Base URL is the shared inference host, e.g. `https://inference.us-west.modal.direct`.
  Our gateway appends `/v1/chat/completions`, so it must NOT include `/v1`.
- The `model` field is **the endpoint's own hostname**, e.g.
  `my-endpoint.us-west.modal.direct` — NOT a model slug like `moonshotai/Kimi-K3`.
- Auth is a Proxy Token: a Token ID (`wk-…`) and Token Secret (`ws-…`) joined with a
  **period** and sent as `Authorization: Bearer wk-….ws-…`. One workspace token reaches
  every Shared Endpoint in that workspace, so switching models means changing only the
  model/hostname — not the URL and not the token.
- To see exactly which endpoints a token can reach:
  `curl https://inference.us-west.modal.direct/v1/models -H "Authorization: Bearer wk-….ws-…"`
- Modal's own Claude Code integration doc says to pick "an Endpoint whose model supports
  tool calling" — so tool-calling support varies by model on this surface, which is
  consistent with GLM-5.3 returning `toolCalls: 0` here.
## Current state and what is NOT proven — 2026-09-25
The owner cannot top up Anthropic credits (card failures), is pre-launch, and is preparing a
LinkedIn launch. Keep this in mind: cost and "can this be tested at all" are real constraints,
not hypotheticals.

**Pre-launch waitlist is ON.** `WAITLIST_MODE` defaults to true. It blocks `/api/build/fast`
for non-admins, blocks `/paddle/config` for everyone (admins included — nobody gets billed
pre-launch), and the frontend shows a thank-you page instead of the product. Admins bypass the
frontend gate via `VITE_ADMIN_EMAILS` (mirrors backend `ADMIN_EMAILS`). Set
`WAITLIST_MODE=false` + `VITE_WAITLIST_MODE=false` to open the product.

## 2026-10-01 — first build where the agent could actually SEE its own page
Everything below this heading (from 09-28) was measured while `check_page` was structurally
incapable of working — see the three sandbox-browser bugs further down. This is the first run
with it genuinely functioning.

Prompt: "Atlas", a 4-view client/project tracker (dashboard + KPI cards + revenue chart,
searchable client table with detail panel, drag-and-drop kanban, settings), localStorage
persistence, validation, empty states, Escape-to-close, responsive to 390px.

| | |
|---|---|
| rounds | **8**, ended `stopReason=end_turn` — the model stopped on its own |
| turn cap | not reached (raised to 40 for this test) |
| cost guard | not reached ($0.84 of $3.00; raised from $1.00 beforehand) |
| wall clock | 2 min 41 s |
| files | **1** |
| creditsUsed | 841 |

Round 4→5 took 51 s and 5→6 took 70 s — the model wrote the app, looked at it, and repaired.
It reported "Atlas is built and rendering cleanly", and the delivered app matched the brief.

**The HMR filter is confirmed in production.** The previous build ended with
`Browser render issue — dispatching fix` over Vite's websocket noise; this one did not fire it
at all.

**Open quality problem: the model puts the whole app in ONE file.** Four views, kanban, chart
and settings all landed in `App.tsx`. It works, but a follow-up edit then has to rewrite the
entire app every time, and one bad line takes down everything. Not yet addressed — it needs
either a prompt instruction to split into components or a rule in `prompt-builder.ts`.

**Cost note:** 841 credits is 2.5× the small build on the same day (325). The old
`MAX_BUILD_COST_USD=1.0` would have cleared this by $0.16 and cut anything larger. Our
reckoning still overstates agentic builds (cached tokens, below), so the real figure is lower —
but it remains unmeasured.

## THE HARNESS WORKS — measured on real builds, 2026-09-28
Two clean agentic builds on Kimi K3 via the Modal shared endpoint, with
`AGENTIC_BUILD_ENABLED=true` and `LLM_PROVIDER_MODE=openai`:

| | first working run | next run |
|---|---|---|
| rounds | 12 (hit `AGENTIC_MAX_TURNS`) | 8 (model finished on its own) |
| files | 3, via `write_files` | 3, via `write_files` |
| creditsUsed | 555 | 357 |

The observed loop: `write_files` → `check_page` → `read_logs` → `check_page` →
`check_types` → `write_files`. The model wrote, looked at what rendered, read the dev-server
log, found its own mistake and repaired it. That is the thing the pipeline structurally could
not do.

**What had to be true first — four bugs, none of them the model's fault.** Claude Sonnet 5,
GLM-5.3 and Kimi K3 each returned `toolCallsMade: 0` and all three were wrongly blamed:
1. `dispatch()` validates options with a Zod object, which drops unknown keys. Half of
   DispatchOptions sits outside that schema deliberately and was re-attached by hand, one
   name at a time — so `agenticBuild`, `onSandboxLog` and `projectFiles` were silently
   stripped and the harness tools were never sent. Now spreads instead of listing.
2. The agentic instruction said it overrode "any instruction below" while sitting
   second-to-last, so it pointed at nothing. It is last now and says "above".
3. `list_files` on a cold sandbox returned a bare "no live sandbox" error; a model read that
   as "the harness isn't available here" and abandoned tools for the whole build. The read
   tools now distinguish "not ready yet" from a real failure.
4. `DispatchResult.modelUsed` reported the Anthropic tier name even on Modal dispatches, so
   logs claimed `claude-sonnet-5` while the request went elsewhere — which misled diagnosis
   for a full day, and also billed against the wrong `MODEL_PRICING` row.

**Still true:** a working preview is still not evidence the harness ran — `build.ts` falls
back to fence parsing when `generatedFiles` is empty, and that path produces a working app
too. Check `[build] agentic mode produced N file(s) via its tools` and the
`Gateway request: tools offered` line before concluding anything.

**Known and NOT fixed — billing overstates agentic builds.** An agentic build resends the
conversation each round, so most input tokens are a repeated prefix the provider bills at its
cached rate ($0.30/MTok on Kimi K3 vs $3.00 full). `computeUsage` charges every input token at
the full rate. The provider dashboard read $0.42 across a day of builds while this put a
single build at $0.555. Fixing it needs the cached-token count from the usage response, which
the gateway does not read yet. Until then `usage_usd` is a ceiling, not a measurement — do not
set prices from it.

**Not yet exercised:** a follow-up EDIT through the harness (new builds only so far), and the
preview iframe occasionally shows "Preview failed to load" and then recovers on retry — a
timing race between the preview URL and Vite being ready, not diagnosed.

**Two routing facts that wasted days of testing — check them before diagnosing anything:**
- Provider is chosen per PLAN, so a paid or admin account silently gets Anthropic no matter
  what the `LLM_*` vars say. `LLM_PROVIDER_MODE=openai` forces every build to the
  OpenAI-compatible endpoint. Each build now logs `[build] provider=… (mode=…)`.
- `MAX_BUILD_COST_USD` is 1.0. Real agentic builds measured 0.357–0.555 by our own
  (overstated) reckoning, so this is not binding yet, but it is close enough to matter.

**To actually test the harness:** set `LLM_*` (or `MODAL_*`) to a working OpenAI-compatible
endpoint, then `AGENTIC_BUILD_ENABLED=true` on Railway. Run one new build and one follow-up
edit. Watch for: did the model call `check_page` at all, did it repair anything, did the edit
preserve untouched files.

**Deferred on purpose:** JEV (`jevai.org`, TypeSafe AI) — a millisecond typed-decision model.
`jev_review_completion` is a genuinely good fit for the harness's worst failure mode (agent
declares "done" on a broken app) because it sits outside the agent's control. Not adopted yet:
the site is a community site with no published pricing, and its two doc pages disagree on the
request shape. Revisit after the harness is running and false "done" rates can be measured.

## Redis lives in a DIFFERENT Railway project — and was dead for two months
`REDIS_URL` points at the `Redis` service in the **`honest-endurance`** project, not
`steadfast-encouragement` where Lampcode runs. Cross-project traffic cannot use Railway private
networking, so it goes over the public TCP proxy (`ballast.proxy.rlwy.net`). If you are looking
for a Redis service next to Lampcode, there isn't one.

**That service's only deployment sat `REMOVED` from 2026-08-05 until it was redeployed on
2026-09-29.** The proxy accepted each connection and reset it, so the log showed
`connected` → `ECONNRESET` every 30 s — which read as background chatter, not as an outage.
Check `latestDeployment` on the Redis service before trusting anything Redis-backed.

What a dead Redis silently costs here, since none of it announces itself:
- **Rate limiting is entirely off** (`rate-limit.ts` fails open after 200 ms). Not urgent while
  `WAITLIST_MODE` is on, but **must be verified working before launch**.
- **Sandbox IDs do not persist**, so every Railway restart orphans every paused sandbox and the
  next open cold-starts. This is the `"sandbox not persisted"` warning.
- **Build events are not buffered**, so a client that refreshes mid-build replays nothing.

**`enableOfflineQueue: false` is deliberate** (`src/lib/redis.ts`). With it on, `maxRetriesPerRequest: null`
means commands issued while Redis is down queue forever and are never flushed with an error —
measured: 200 buffered build events left 800 commands resident and produced **zero** rejections,
so every `.catch()` in the app was dead code. Every Redis call site must therefore degrade on
*any* error, not just `RedisTimeoutError` — three of them re-threw and would have failed builds.

Two consequences of that switch, both already handled — do not "fix" them again:
- `createRedis()` **connects eagerly** (`client.connect()` at creation). Without it, `lazyConnect`
  defers the handshake to the first command, which then loses the race and is rejected; Railway's
  healthcheck made that log a false `"[rate-limit] Redis unavailable"` on every single deploy.
- **The Socket.IO adapter's two clients keep the offline queue** (`websocket/server.ts`).
  `RedisAdapter`'s constructor calls `subClient.psubscribe()` before the socket is open and never
  handles the promise, so disabling the queue there is an unhandled rejection that **crash-loops
  the service on boot** — it did, on 2026-09-29. The surrounding try/catch does not help; a
  rejected promise walks straight past it.

## Sandbox-side scripts must live in `/home/user/.lampcode-tools`
Playwright is installed there, in its own `node_modules`, deliberately outside the generated
app's dependency tree (`template.ts`). Node resolves a bare specifier like `"playwright"`
relative to **the importing file**, never the process working directory — so a script written to
`/tmp` dies with `ERR_MODULE_NOT_FOUND` no matter what you `cd` into first.

`fetchReferenceDesign` and `capturePreviewScreenshot` both did exactly that (`cd
/home/user/.lampcode-tools && node /tmp/lampcode-*.mjs`), which means **`fetch_reference` and
the preview thumbnail never worked once** — not flaky, impossible. Fixed 2026-09-29 by writing
the scripts into `TOOLS_DIR`.

### …and that directory was never in the image either — why `check_page` never worked
`npm init -y` names the package after its directory, and npm **rejects a name starting with a
dot**. In `.lampcode-tools` it exits with `npm error Invalid name: ".lampcode-tools"`, which
took down the whole `&&` chain behind it:

```
RUN npm init -y && npm install playwright && npx playwright install --with-deps chromium
```

**Every template build failed at that step from 2026-09-09 (when it was added) to 2026-10-01**,
so the live template stayed frozen at its pre-09-09 state and never contained playwright or
`check-render.mjs`. `check_page` therefore returned "the sandbox did not respond" on every
build it has ever run in — the agent was never once able to look at its own page. Nobody saw it
because the template is rebuilt by hand and its log was never read.

Fixed by writing the manifest explicitly instead of generating it.

### …and then Chromium landed where the sandbox user could not read it
With that fixed the build succeeded and `check_page` would *still* have failed. The image is
**built as root but run as `user`**, and playwright resolves its browser directory from the
running user's home — so `playwright install` put Chromium in `/root/.cache` and launching it
as `user` died with `Executable doesn't exist at /home/user/.cache/ms-playwright/…`. The error
names the path it wanted, not the path it used, so it reads like a missing install.

`PLAYWRIGHT_BROWSERS_PATH=/home/user/.lampcode-tools/browsers` now, set BOTH as a Docker `ENV`
and as a prefix on the three commands in `e2b-service.ts` (`TOOLS_ENV`). The prefix is not
redundant: **the Docker ENV does not survive into E2B's runtime** — measured, a sandbox command
without the prefix still looked in `/home/user/.cache`.

**Three separate bugs were breaking the same capability** — the sandbox's browser: the script
written to `/tmp`, the `npm init` failure, and the browser path. Each alone was enough for
`check_page` to report that the sandbox did not respond.

**Verified 2026-10-01 in a live sandbox** (not inferred): `browsers/` holds chromium-1243 +
chromium_headless_shell-1243, `chromium.launch()` returns LAUNCH OK as `user`,
`check-render.mjs` emits parseable JSON, and the `fetch_reference` mechanism loads an external
URL and returns its JSON marker.

**`e2b-template/verify-template.ts` now does that check for you** — run it after EVERY template
build, because a green `✅ Template built` has proved nothing here twice:

```bash
cd e2b-template && npx tsx verify-template.ts     # needs the same .env as build.ts
```

It starts a real sandbox and checks, with the same commands and paths the backend uses: who the
commands run as, that `node_modules` is writable by that user, that the vitest config and setup
are baked in and wired to tsconfig, that the test tooling is installed, that a logic test and a
component test both pass and the JSON report parses, that `tsc --noEmit` is clean over them,
that Chromium launches as `user`, and that the Python backend deps are present. It exits
non-zero if anything fails.

Lesson: when a template build fails, every sandbox silently keeps running the LAST GOOD image.
Nothing downstream reports a stale template, so always read the build log to its last line.

## The capability roadmap — agreed 2026-10-02, in this order
The goal is a coding agent that handles long, complex, full-stack projects and finds and fixes
its own bugs. What stands between here and there is mostly TOOLS, not the model. The agent has
seven: `write_files`, `check_page`, `check_types`, `list_files`, `read_file`, `read_logs`,
`fetch_reference`. What is missing from that list is the ceiling.

**1. A surgical `edit_file` — DONE (2026-10-01).** `write_files` replaces a file ENTIRELY, so a one-line change
means rewriting the whole file. Two consequences: project size is bounded by what the model can
rewrite in a turn, and every edit risks the rest of the file — on 2026-10-01 an edit replaced a
working `App.tsx` with a fragment. `edit_file(path, old_string, new_string)` with exact-match,
must-be-unique semantics is what Claude Code and Cursor use, and it is the single change that
makes long projects structurally possible. `write_files` stays for new files.

**2. An evaluation harness — 20 tasks is enough. DONE (2026-10-02), see `scripts/eval/`.**
At the time this was written `npm test` exited 1; it now runs the repo's own cases. Both prompt changes made
on 2026-10-01 (file splitting, the palette) rest on ONE build each; nobody can say whether they
help in general. Twenty fixed prompts scored on fixed criteria — build completed, page rendered,
typecheck clean, rounds, cost — run before and after every prompt or harness change. Until this
exists, every other improvement here is a guess. Do it second so the rest can be measured.

**3. The agent must be able to run tests — DONE (2026-10-02), see below. Template rebuild
still required.** When this was written no test runner existed anywhere: the template had no
vitest or jest, and there is no `run_tests` tool. The agent can ask "did it render" and "did it
compile" but never "is it correct", which is exactly why bug-finding is capped. Add vitest to
the template, add the tool, and ask the model to cover non-trivial logic.

**4. Persist files as they are written — DONE (2026-10-02).** `uploadProjectFiles` ran once, at
the end of a build. The ForgeFlow build hit the cost ceiling at round 14 with 15 files written
and lost all of them — `restore: project has no stored files`. Now `persistFilesAsWritten`
stores each write as it happens; see below.

**5. A planning phase for long builds — DONE (2026-10-02).** ForgeFlow died mid-repair at round
14. A cheap plan dispatch producing a file-by-file plan, then execution against it, makes a
long build tractable and resumable instead of one long improvisation. See below.

**6. Project memory from what the harness already knows — DONE (2026-10-02).**
`memory-generator.ts` failed on every build (Anthropic credentials, which are not set). It is
now derived from the project's own files, with no model call. See below.

**Explicitly NOT yet:** new models, market positioning, or the agent-research papers. Those
matter once the foundation holds.

## Every build now records what it did — and there is an eval set
Until 2026-10-02 a finished build left no evidence beyond `status = success`. Rounds used,
whether the agent called its own gates, what they said, which tools it reached for: none of it
was stored. That is why the unstyled-page bug survived three months and why `check_page` could
be structurally incapable of running for three weeks while the model was blamed.

**`build_sessions.build_outcome`** (jsonb, type `BuildOutcome` in `schema.ts`) is written at
the end of every build — on failure too, with whatever was gathered before the throw. It holds
`rounds`, `turnsExhausted`, `filesWritten`, `toolCalls` (a per-tool count), `checkPage`,
`checkTypes`, `costUsd`, `durationMs`. `GET /api/build/:sessionId/status` returns it.

The gate fields keep four states apart, and collapsing them is the mistake to avoid:
`pass` / `fail` (the gate ran), `unavailable` (the gate could not run — a sandbox problem, not
a model problem) and `never` (the model did not call it). On the **pipeline** path all gates
read `never` and `rounds` is 1 — it has no agent gates, so that is not a finding.

**`scripts/eval/`** is twenty fixed prompts (4 smoke, 11 core, 5 hard) run through the real
HTTP API, scored against `build_outcome` plus the generated files. See its `README.md`. It
spends real money — every task is a real build.

**It signs in itself** (`scripts/eval/auth.ts`) from `EVAL_EMAIL` + `EVAL_PASSWORD` +
`EVAL_SUPABASE_ANON_KEY` (the public client key the frontend already ships), and refreshes the
session 5 minutes before expiry. That is not convenience: a Supabase access token lives about
an hour and a full run is sixty minutes or more, so a hand-pasted token expires partway through
and every remaining task fails with a 401 that reads like a broken harness. `EVAL_TOKEN` is
still honoured as an override but is never refreshed. The account must be an admin while
`WAITLIST_MODE` is on. `EVAL_BASE_URL` for production is
`https://lampcode-production.up.railway.app`.

```bash
npm run eval -- --tier smoke --label baseline   # --dry-run needs no credentials at all
npm run eval:report                             # newest run
npm run eval:report -- --diff old.json new.json
npm test                                        # scoring rules + parsers, costs nothing
```

**Never edit an existing task's `prompt`** — it makes every stored run incomparable. Add a new
task and set `retired: true` on the old one. `npm run typecheck` now also checks `scripts/`
via `tsconfig.scripts.json`.

## FIRST REAL EVAL RUN — smoke tier on Kimi K3, 2026-10-03
Label `kimi-baseline`. Four builds against production, provider=modal (mode=openai),
`AGENTIC_BUILD_ENABLED=true`. **This is the baseline every later change gets diffed against.**

| task | verdict | rounds | files | page | types | tests | cost | time |
|---|---|---|---|---|---|---|---|---|
| counter | pass | 3 | 1 | pass | never | never | $0.060 | 30s |
| todo | soft-fail | 9 | 7 | pass | never | never | $0.162 | 67s |
| pricing-page | pass | 5 | 3 | pass | never | never | $0.125 | 60s |
| form-validation | pass | 8 | 15 | pass | **pass** | **pass** | $0.278 | 104s |

4/4 built, 3 passed every check, 0 build failures, 0 harness errors. Mean 6.3 rounds, 65 s,
$0.626 total by our own (overstated) reckoning. Turn cap never reached.
Tool mix: `edit_file`×8, `check_page`×6, `write_files`×5, `read_file`×2, `list_files`×2,
`read_logs`×1, `run_tests`×1, `check_types`×1.

**`check_page` passed on all four — the first time it has ever worked in production.** The
capability that three separate bugs kept structurally broken for three weeks is confirmed live
on the rebuilt template.

**`run_tests` and `check_types` also work live**, on `form-validation` — the one task with
logic whose correctness is not visible by reading it. 15 files, tests written, tests run,
types checked, all passing. The other three never called either, and that is the prompt working
as designed rather than neglect: they are presentation-heavy, and the instruction explicitly
says to skip tests for those. `check_types` being skipped on 3 of 4 is the weaker half of that —
it is cheap and always useful — but it is not something the prompt demands.

**`edit_file` is being used, not merely offered.** The `todo` build called it six times:
write once, `check_page`, `read_logs`, then six surgical repairs. That is the write-look-repair
loop running on the tool added on 2026-10-01, instead of rewriting whole files.

**Finding 1 — the classifier escalates browser-only prompts to fullstack+DB on single
keywords.** Measured on the smoke set:

```
counter           frontend   db=none      auth=false
todo              fullstack  db=supabase  auth=false   ← the word "persist"
pricing-page      frontend   db=none      auth=false
form-validation   fullstack  db=supabase  auth=true    ← "signup"/"password"
```

`\bpersist(?:ence|ent)?\b` matched "Tasks **persist** across reloads", which in practice means
localStorage, and a three-step signup *form* (pure UI) drew a database and auth. Half the smoke
set was affected. Worse, the preview Supabase project is **paused**, so those builds' persistence
could not actually work — `todo` shipped `db/schema.sql` + a Hono backend and no working storage.
**FIXED 2026-10-03 — see "The classifier no longer guesses fullstack from one word" below.**

**Finding 2 — the `todo` soft-fail was partly the check's fault.** `mustContain: localStorage`
asserted a mechanism, and the build persisted via a backend instead. **FIXED**: the eight
persistence checks now use a shared `PERSISTS` pattern that accepts localStorage, sessionStorage,
IndexedDB, a Supabase client, or a `fetch("/api/…")` call — any real mechanism — while a build
that stores nothing still fails. Verified on the shapes the real builds produced. The `todo` row
of the baseline above is therefore superseded: under the current checks that build would pass.

**Reproducing it:** the run is in `eval-results/` (gitignored, local to whoever ran it). Keep
the numbers above as the comparison point; `npm run eval:report -- --diff` needs both files, so
a later run can only be diffed against a locally held baseline.

**Which provider a run would use — confirmed from Railway on 2026-10-02.** Every recent build
logged `[build] provider=modal (mode=openai)` with agentic mode on, and `ANTHROPIC_API_KEY` is
not among the service's variables at all. So an eval run goes to Kimi K3 on the Modal shared
endpoint and needs no Anthropic credit. Note that Modal **plan credits do not cover
shared-endpoint usage** — it is billed per token, so what matters is that the payment method
works, not the plan balance.

## The agent can run tests — `run_tests`, 2026-10-02
`check_page` answers "did it render" and `check_types` answers "does it compile". Neither can
answer "is it correct", so a build that computes the wrong total passed every gate. That was
the ceiling on bug-finding.

**`run_tests()`** runs vitest inside the sandbox and reports which tests failed and why.
Four outcomes, deliberately kept apart — `pass`, `fail`, **`none`** (it ran; the project has no
tests) and `unavailable` (the runner could not run). "No tests" is NOT a pass: an agent told
its tests passed after writing none has proof of correctness it never earned. Recorded as
`buildOutcome.checkTests`, so the eval can see whether the agent tests anything at all.

**vitest lives in the generated app's own devDependencies**, not in `.lampcode-tools` with
playwright. A test file does `import { describe } from "vitest"`, and Node resolves a bare
specifier relative to the IMPORTING FILE — a vitest installed anywhere else is invisible to the
tests that need it. Installed: `vitest`, `jsdom`, `@testing-library/react`,
`@testing-library/dom` (a peer of RTL v16, and `--legacy-peer-deps` does not install peers),
`@testing-library/jest-dom`.

**`vitest.config.ts` is its own file, not a `test` key in `vite.config.ts`.** vite.config.ts is
the most load-bearing file in the image — if its imports fail, the dev server never starts and
every build dies — and importing `vitest/config` there would hang that on a devDependency. It
is in `BAKED_FILES`, with `vitest.setup.ts`, so the model cannot overwrite the harness its own
tests run in.

**`vitest.setup.ts` is in tsconfig's `include`, and that is load-bearing.** It holds jest-dom's
type augmentation, which must be in the SAME TypeScript program as the test files. Verified both
ways: without it, `tsc --noEmit` reports `toBeInTheDocument()` as a non-existent matcher on a
test that passes perfectly — `check_types` failing on correct code, and the agent then "fixing"
working logic.

**Verified by running it, not by reading it.** vitest 2.1 was installed in a scratch project
holding the template's real `package.json`, `vitest.config.ts`, `vitest.setup.ts` and
`tsconfig.json`, extracted verbatim from `template.ts`:
- `npm install --legacy-peer-deps` of the full dependency set succeeds
- a logic test importing through the `@/` alias passes
- a component test (`render`, `screen`, `toBeInTheDocument`) passes — so jsdom, the react
  plugin and the setup file are all wired
- `css: false` does not break a component that imports its own stylesheet
- `tsc --noEmit` is clean over both test files
- `parseVitestOutput` has 25 cases (`npm test`) against **real** vitest output captured from
  that project — mixed pass/fail, all-pass, no-test-files, a component-test failure — plus the
  ways a run yields no report at all. Fixtures live in `scripts/fixtures/vitest/`.

**TEMPLATE REBUILT AND VERIFIED — 2026-10-02.** `lampcode-vite` was rebuilt (2m4s, 27 steps,
zero errors, log read to its last line) and then checked in a live sandbox with
`verify-template.ts`. All eleven checks passed, the ones that matter being: a logic test and a
component test both pass with a parseable JSON report (`total=2 passed=2`), `tsc --noEmit` is
clean over both, and Chromium still launches as `user` — so `check_page` did not regress.
`run_tests` is live.

One correction to record, since it is the kind of thing that becomes folklore: a
`chown -R user:user /home/user/app` was added to the template on the theory that node_modules
was root-owned and unwritable by the sandbox user. **That theory was wrong.** E2B's own
`[config]` phase ends every build with "Give 'user' ownership to /home/user", so ownership is
already correct. The step is kept as an explicit statement of the requirement, but it is belt
and braces — do not reason from its presence, and do not add more chowns on its model.

## Files are stored as they are written — 2026-10-02
`persistFilesAsWritten` (`src/storage/project-files.ts`) is called from three places:
`write_files` and `edit_file` store just the file(s) that changed, and `build.ts` stores the
whole set the moment it is assembled, before the five repair loops that follow it. The
end-of-build sync still runs and upserts anything those loops changed.

Uploads are upserts keyed on path, so incremental writes converge on the same stored project as
one sync at the end, for a fraction of the requests.

**Awaited, not fired and forgotten.** A detached upload dies with the process, and a dying
process is one of the cases this exists to survive. It cannot throw and is bounded by a 15 s
timeout — storage trouble must never fail a build whose code is already written and running.
Verified with no Supabase credentials configured: resolves, does not throw, logs the
degradation, and the process exits immediately rather than being held open by the timer.

**The trade-off, on purpose:** a FAILED EDIT now leaves partial work in storage where it used
to leave the last good version. Restore prefers a live sandbox and only falls back to storage,
and that sandbox already holds the partial edit — the user watched it happen — so this makes
storage agree with what they already saw instead of silently reverting their newest work. A
half-finished edit can be finished; work that was never stored is gone. Reverting a failed edit
properly would need a previous-version snapshot, which is not built.

## Long builds get a plan first — 2026-10-02
A big build used to be one long improvisation: the model found out what the app was while
writing it. That is where the one-file-app habit comes from, and when the ForgeFlow build died
at round 14 nothing anywhere stated what it had set out to make, so there was nothing to resume
against.

**`src/agents/build-planner.ts`** runs ONE cheap dispatch before the build and returns a
file-by-file plan: `{ summary, files: [{ path, purpose }], outOfScope? }`. It decides layout and
nothing else — no schemas, no libraries, no code. A plan that specifies everything costs as much
as the build and is wrong by the second file.

**`shouldPlan` is deliberately narrow.** Only new builds, only agentic mode, only prompts of
`BUILD_PLAN_MIN_WORDS` (default 60) or more:
- an EDIT already has a layout, the project's own — planning again invites restructuring a
  working app, the opposite of what an edit should do;
- the PIPELINE path never reads a plan, so planning for it is paid for and thrown away;
- a SMALL build does not need one and should not pay for one.

`BUILD_PLANNING_ENABLED=false` switches it off entirely. Both vars use the same explicit-string
parsing as `AGENTIC_BUILD_ENABLED`, for the same reason: `z.coerce.boolean()` reads `"false"` as
true.

**The plan is stored before the build runs**, in `build_sessions.plan_tasks`. Writing it at the
end would lose it in exactly the case it exists for. That column previously held an unused
`PlanTask` type from a multi-agent design that was never built — NULL in all 309 rows, no reader
or writer — so it is reused rather than migrated, which is why the column name does not match
the `BuildPlan` type.

**The plan is handed to the builder as a starting point, not a contract.** The planner saw only
the prompt; the builder can see the running app, so when they disagree the builder has the
evidence. What the block does forbid is collapsing the layout back into one large file.

**The `planning` agent type was already there and dead** — a "BuildForge Architect / CONTRACT.md"
prompt writing a full technical spec for specialized agents that were never built, dispatched by
nothing. Its prompt is replaced; its model tier and `JSON_OUTPUT_AGENTS` membership were the
useful parts and are reused. The new prompt is 1748 chars.

**Costs are counted.** `planCostUsd` is added to `cumulativeCostUsd` and to
`buildOutcome.costUsd` — a planned build must not look cheaper than it was. `buildOutcome` also
records `planned` and `plannedFiles`, and the eval report prints planned-vs-unplanned, so
whether planning helps is a question the harness can answer rather than a matter of opinion.

**Never throws.** Every failure path returns no plan and the build proceeds exactly as it would
have: a parse failure, a dispatch error, a DB write failure. `parsePlan` also refuses a plan
that would make things worse — empty, unparseable, or naming only template-owned files — and
drops individual template-owned paths so the build does not try to write one, get refused, and
read that as a failure. 32 cases in `npm test`.

**Not yet run against a real build.** The gating, parsing and prompt-injection are verified by
cases and by inspecting the assembled prompt; no planned build has actually been dispatched.

## Project memory is derived, not generated — 2026-10-02
`memory-generator.ts` used to dispatch Haiku over 8 KB of concatenated code and ask it to write
a prose summary. It built its Anthropic client from `config.ANTHROPIC_API_KEY`, which is not set
on Railway, so it logged `[memory-generator] failed: Could not resolve authentication method` on
**every build** and returned the previous memory instead. It never failed a build, which is
exactly why nobody noticed memory had stopped being written.

It is now pure, synchronous and incapable of failing. Everything the old prompt asked a model to
infer is already knowable from the files: which packages are imported, what the `:root` tokens
are, which files exist, what tables the SQL declares. Deriving it costs nothing, needs no
credentials — the absence of credentials being the whole problem — and cannot name a component
that does not exist.

The one thing a model genuinely did better was "what was built, and why". That is not inferred
either: **the user's own prompts are kept verbatim**, oldest first, capped at 8. Their words beat
any summary of their words. That list is the only part that accumulates; every other section is
re-derived each build, so a stale fact cannot survive one.

Sections: the prompt history, the detected stack, the structure (views / components / logic
modules / tests / backend files, listed), declared SQL tables, and the project's own design
tokens with an instruction not to change them. A real four-view CRM's memory comes to ~1.1 KB.

**It deliberately does not repeat the file manifest.** Both are injected into the same edit
prompt, so memory answers WHAT and WHY and the manifest answers WHERE. Restating the manifest's
per-file export lists here would spend the edit's context twice on the same facts — there is a
case asserting `exports:` never appears.

**Migration is graceful, not lossless.** 53 of 311 projects hold memory in the old LLM shape,
from whenever the key was present. `parseHistory` returns nothing for that shape, so those
projects start their history fresh at their next build and everything else is re-derived; the
old prose is replaced rather than merged. Carrying the old "What Was Built" paragraph forward
once would be possible and is not built.

44 cases in `npm test`, the most important being the round trip: build N's memory must be
readable by build N+1, and the cap must drop the OLDEST entry, never the newest.

## The classifier no longer guesses fullstack from one word — 2026-10-03
`classifyBuild` decides whether a build gets a Hono backend and a Supabase schema, from the
prompt alone. It was ONE regex alternation mixing three unrelated kinds of signal, and the first
eval run measured the cost: half the smoke set asked for a browser-only app and got a database
it could not use, because the preview Supabase project is paused.

Split into named signals:
- **`SERVER_DATA_RE`** — things that genuinely need another machine: a named database, a backend
  framework, an API, multi-user, real-time, payments, file uploads, cloud sync.
- **`AUTH_RE`** — identity. Real auth needs a server; the WORD does not.
- **`AUTH_AS_UI_RE`** — "a login *page*", "a signup *form*" is interface, not a system. This is
  what stopped a three-step signup form from drawing auth scaffolding it never used.
- **`CLIENT_ONLY_RE`** — localStorage, "no backend", "frontend-only", mock data. An explicit
  browser-side instruction beats a soft inference; a named database still wins over it, because
  "store it in Supabase and cache in localStorage" really is fullstack.
- A bare **`persist`** is no longer a server signal at all. "Save to database" and "real
  database" already catch the case where the user means otherwise.

**3D / animation keywords were removed from the decision entirely.** They used to force
fullstack, with the stated reason of routing the build to E2B where Three.js and Spline are
pre-installed — but `wantsE2BPreview` in build.ts is hardcoded `true`, so every build goes to
E2B regardless. By the end all those keywords did was give a Three.js landing page a Supabase
schema.

**One bug the cases caught in the fix itself:** "no backend" contains the word `backend`, so an
instruction NOT to build one read as an instruction to build one. Negations are stripped
("no/without a/doesn't need a" + backend/server/database/api) before server signals are matched.

`reason` now says which signal fired, since it is what you read during triage.

44 cases in `npm test` (`scripts/classifier.test.ts`), including all twenty eval prompts, the
Atlas prompt from 2026-10-01, and the genuine-fullstack cases — so a future narrowing cannot
quietly break what was already right.

## HARD TIER — the first run where the whole roadmap was exercised, 2026-10-03
Label `hard-after-classifier-fix`, five long builds on Kimi K3 after the classifier fix was
deployed (`b678614`).

| task | verdict | rounds | files | page | types | tests | cost | time |
|---|---|---|---|---|---|---|---|---|
| crm | pass | 10 | **22** | pass | never | pass | $0.565 | 204s |
| project-tracker | pass | 7 | 10 | pass | pass | pass | $0.284 | 151s |
| form-builder | pass | 5 | 8 | pass | never | pass | $0.269 | 119s |
| spreadsheet | soft-fail | 8 | 3 | pass | never | pass | $0.151 | 70s |
| editor-undo | soft-fail | 6 | 6 | pass | pass | pass | $0.187 | 101s |

5/5 built, 3 passed every check, **0 build failures, 0 harness errors, turn cap never reached**.
Mean 7.2 rounds, 129 s, $1.456 total. `check_page` 5/5. **`run_tests` 5/5 — every single hard
build wrote tests and they passed.** `check_types` called on 2 of 5.

**No one-file builds, on the tier designed to produce them.** Smallest was 3 files, largest 22.
The habit that put four views, a kanban and a chart in one `App.tsx` for three months did not
appear once.

**Same-app before and after.** The 2026-10-01 "Atlas" build and today's `crm` are the same
brief — a four-view CRM with a dashboard, client table, kanban and settings:

| | Atlas, 10-01 | crm, 10-03 |
|---|---|---|
| files | **1** | **22** |
| rounds | 8 | 10 |
| credits | 841 | **508** |
| tests | none | written and passing |

Better structured AND cheaper.

**Finding 3 — `BUILD_PLAN_MIN_WORDS=60` is mis-calibrated. Only 1 of 5 hard tasks planned.**

```
crm                62 words  plans=true
project-tracker    55 words  plans=false
form-builder       55 words  plans=false
spreadsheet        53 words  plans=false
editor-undo        41 words  plans=false
```

The tier whose whole purpose is long, complex builds mostly does not plan. `spreadsheet` — a
formula evaluator with circular-reference detection — is unarguably complex and its prompt is
53 words, so it got no plan and wrote 3 files, which is what its soft-fail is. `crm` cleared the
bar by two words, planned 22 files and wrote exactly 22. One case is not causation, but the
calibration is wrong independently of that: word count is a poor proxy for complexity. Not
fixed. Options: drop the threshold, or gate on complexity signals (distinct views/features)
rather than length.

**Finding 4 — a build passed all three of the agent's own gates and still shipped a missing
requirement.** `editor-undo` renders, type-checks, and its own tests pass — and it has **no
persistence at all**. No `localStorage`, no `setItem`, no `JSON.stringify`; confirmed by reading
all six generated files. The prompt said "Notes persist". Close the tab and the work is gone.

This is the clearest justification for the eval existing. `check_page` sees a page, `check_types`
sees types, `run_tests` sees the tests the agent chose to write — none of them can see a
requirement the agent simply forgot. Only an outside check comparing the brief to the output
catches it.

**`check_types` remains the standing gap:** called on 3 of the 10 builds run today. It is cheap
and always useful, and nothing in the prompt requires it.

## CORE TIER — 11/11, and the three fixes confirmed on real builds, 2026-10-03
Label `core-after-all-fixes`, against deploy `371c960` (planning recalibration + the
`check_types` step + the billing fix all live).

| task | rounds | files | page | types | tests | cost | time |
|---|---|---|---|---|---|---|---|
| kanban | 6 | 10 | pass | pass | pass | $0.263 | 165s |
| dashboard | 6 | 17 | pass | pass | pass | $0.364 | 192s |
| data-table | 5 | 10 | pass | pass | pass | $0.276 | 193s |
| calendar | 3 | 12 | pass | pass | pass | $0.200 | 166s |
| chat-ui | 5 | 10 | pass | pass | pass | $0.186 | 141s |
| file-explorer | 5 | 12 | pass | pass | pass | $0.233 | 140s |
| settings-tabs | 7 | 14 | pass | pass | pass | $0.247 | 203s |
| wizard-state | 10 | 21 | pass | pass | pass | $0.447 | 198s |
| search-filter | 3 | 10 | pass | pass | pass | $0.160 | 99s |
| theme-system | 3 | 20 | pass | pass | never | $0.181 | 116s |
| python-api | 5 | 9 | pass | pass | never | $0.216 | 97s |

**11/11 built, 11/11 passed every check, 0 soft-fails, 0 failures, 0 harness errors.** Mean
5.3 rounds, 155 s, $2.774. Turn cap never reached. No one-file builds; mean 13 files.

**All three of the morning's fixes are confirmed by measurement, not argument:**

| | before | after |
|---|---|---|
| builds that planned | 0 of 11 core (60-word bar) | **11 of 11**, mean 12.1 planned files |
| `check_types` called | 3 of 10 builds that day | **11 of 11, all pass** |
| genuine fullstack still detected | — | `python-api` kept its FastAPI backend (`src/server/main.py`, 92 L, + `requirements.txt`, `db/schema.sql`) |

The `check_types` number is the sharpest: it went from a third of builds to all of them by
adding one numbered step with the reason attached — Vite does not type-check, so a type error
renders a normal-looking page and ships. Stating the consequence changed the behaviour where
mentioning the tool had not.

`run_tests` was skipped on two: `theme-system` (a component gallery — presentation, which the
prompt says to skip) and `python-api`. The second is a mild gap: a CRUD API has logic worth
testing, and it wrote none.

**Today's three runs together — 20 builds, $4.86, zero build failures and zero harness errors.**

| tier | built | all checks held | planned | types pass | tests pass | spend |
|---|---|---|---|---|---|---|
| smoke (pre-fix) | 4/4 | 3/4 | 0/4 | 1/4 | 1/4 | $0.626 |
| hard (post-classifier) | 5/5 | 3/5 | 1/5 | 2/5 | 5/5 | $1.456 |
| core (post-all-fixes) | 11/11 | **11/11** | **11/11** | **11/11** | 9/11 | $2.774 |

## TWO OWNER-REQUESTED BUILDS — and Finding 5, the sharpest one yet, 2026-10-03
Two deliberately hard one-off builds through the production API, on Kimi K3, deploy `dea287f`.
Not added to `scripts/eval/tasks.ts`: a task in that set is a fixed comparable measurement, and
adding two is a decision about the eval set rather than a test run.

| task | rounds | files | page | types | tests | cost | time |
|---|---|---|---|---|---|---|---|
| MERIDIAN — scroll-driven Three.js site | 17 | 18 | pass | pass | pass | $0.522 | 306s |
| SCOUT — research agent, Python backend | 17 | 27 | pass | pass | pass | $0.639 | 593s |

Both planned (18 planned → 18 written; 23 planned → 27 written). 17 rounds each, against a core
tier mean of 5.3 — the prompts were harder and the loop scaled to them instead of stopping early.
Turn cap never reached. SCOUT took the **Python path** unprompted by the classifier's keywords —
FastAPI, a tool registry, SSE — the second real exercise of that route after `python-api`.

Checked against the brief by hand, the way Finding 4 was. SCOUT met every stated requirement:
registry with three tools and a docstring stating a fourth needs no loop change, `MAX_STEPS = 6`,
stop reasons kept apart (`completed` / `failed` / `max_steps` / `tool_error`), SSE, citation chips
with `scrollIntoView`, run persistence, retry, and tests for the planner and the registry.
MERIDIAN met every one too — `MAX_DPR = 2`, `visibilitychange` pausing, `dispose()` on unmount,
`prefers-reduced-motion` plus a toggle, per-chapter `fogDensity` from 0.012 to 0.048, four
chapters of real copy, responsive via Tailwind breakpoints.

### Finding 5 — all three gates passed and the headline feature was invisible
MERIDIAN's whole point is the WebGL scene. In the preview it is **not visible at all**: the page
is flat near-black behind the text. `check_page` passed, `check_types` passed, `run_tests` passed.

It is not a Three.js failure and not a headless-WebGL limitation — both were ruled out by running
the generated code locally against a real WebGL 2.0 context and screenshotting the canvas in
isolation, which shows the points globe and particle field rendering correctly. The cause is one
CSS declaration in `App.tsx`:

```jsx
<div className="relative min-h-screen bg-[#04080e] …">   // app shell
  <OceanCanvas … />                                      // fixed inset-0 -z-10
```

The shell is `position: relative` with `z-index: auto`, so it is **not** a stacking context. The
canvas wrapper's `-z-10` therefore resolves against the root, where negative-z-index children
paint before positioned descendants — so the shell's own opaque background paints *over* the
scene. Setting that one background to transparent at runtime makes the full scene appear.

**Why this matters more than a CSS bug:** it is Finding 4's shape in the visual domain. The agent
can ask "did it render", "does it compile" and "do my tests pass", and all three answer yes while
the one thing the user asked for is painted over. `check_page` looks for a render and console
errors; a uniformly flat page is neither. This is the same blind spot that let the unstyled-page
bug survive three months.

**FIXED 2026-10-04 — prompt rule, plus the gate that was keeping it from being delivered.**

1. `ANIMATION_DEFAULT_INSTRUCTION` (`prompt-builder.ts`) now carries a FULL-BLEED BACKGROUND
   LAYERS block: the trap stated outright (a `position:relative` shell with no `z-index` is not
   a stacking context, so `-z-10` resolves against the root and paints below the shell), the
   wrong pattern, and the right one — background on the canvas layer, content lifted with
   `relative z-10`, never a background on the shell.
2. **`isAnimationBuild` was the bigger half.** That block is gated on it, and its regex matched
   motion words only — `three\.?js`, `webgl`, `r3f`, `react.three` were absent, so "a landing
   page with a Three.js globe" matched NOTHING and got no 3D guidance at all. The build that
   most needs the stacking-context warning was the one structurally unable to receive it.
   MERIDIAN only squeaked in on "particle field" and "camera animation". Now added, with cases
   confirming it still stays quiet on "a pricing page with three tiers" and a plain CRUD prompt.

**Correcting what this section said yesterday:** a near-uniform-frame gate would NOT have caught
this. MERIDIAN's page was not uniform — the headline, the depth gauge and the motion toggle were
all visible and correct; only the canvas was covered. That check catches a BLANK page (the 4714-byte
thumbnail), which is a different bug. A gate that would catch this one has to compare the composite
against the canvas's own contribution — screenshot, hide the canvas layer, screenshot again, and
fail when the two are identical. That is precise and cheap, and it needs a TEMPLATE REBUILD,
because `check-render.mjs` is baked into the image (`template.ts:453`), not written at runtime.
Not done — flagged as the remaining step.

**Also reconfirmed:** the preview thumbnail capture still races the page. SCOUT's came back at
exactly 4714 bytes — the known blank — so its screenshot had to be produced by running the
generated code locally. 

## Why every build came out black and white — 2026-10-04
The owner's observation, and it was right: every app looked monochrome. Two causes, and the
mechanical one is the bigger.

**1. The baked tokens are literally greyscale.** Every variable in the template's `styles.css`
is `oklch(L 0 0)` — zero chroma. `--primary` is near-black, `--accent` near-white; only
`--destructive` has any hue. `styles.css` is in `BAKED_FILES`, so the model cannot overwrite it,
and the prompt told it "all color customisation must be done via Tailwind utility classes
(bg-primary, text-muted-foreground, …)". Those classes resolve through exactly those grey
tokens. An agent following the house component patterns obediently produced a black-and-white
app every single time — that was the default, not a choice the model made.

**2. The prompt mandated a single house style** for every app: a near-neutral foundation at
"95% of the page", "ACCENT: exactly ONE, and desaturated" with six fixed hex values as "the
register", a BANNED list, and "Think Aesop, Kinfolk, Cereal magazine, Loro Piana". It also
contradicted the two lines directly above it — "Choose colors that MATCH the app's purpose" and
"Each app must have its OWN unique visual identity" — and the mandate won.

**Both fixed.** The COLOR block now says the palette belongs to the app, not to a house style:
the user's own words win absolutely; if they said nothing, the model must still make a real
choice rather than defaulting to grey; colour may carry weight. What is forbidden is bad craft —
vibrating pairs, contrast below WCAG AA, more than two competing accents, raw hex where tokens
belong — not colour itself. Semantic colours stay conventional.

**And the mechanism is now stated**, because the prompt rule alone would not have been enough
against grey tokens: write `src/theme.css` redefining the tokens on `:root` (and `.dark`) and
import it in `src/index.tsx` AFTER `./styles.css`. **Verified by running it, not by reasoning:**
the template's real `STYLES_CSS` was extracted verbatim into a Vite + Tailwind v4 project with
such an override, and the computed styles came back `oklch(0.55 0.21 264)` for `bg-primary`,
`oklch(0.72 0.18 55)` for `bg-accent` — the override reaches the utilities, because
`@theme inline` maps `--color-primary: var(--primary)` and inlines the var reference. Without
it those would have read `oklch(0.205 0 0)`. No template rebuild needed; `src/theme.css` is not
a baked file.

**A correct no-op, recorded so it is not re-investigated:** the prompt tells the model to
`import { motion } from "framer-motion"` while the template installs `"motion": "^11.11.0"`,
which looks exactly like prompt-vs-reality drift. It is not — `framer-motion` ships as a
dependency of `motion` v11 and is present in `node_modules`, so the import resolves. Checked by
installing the pinned version and listing the tree. Left alone.

## Routing, extra packages, and two GSAP facts — 2026-10-04
Four things found while answering "what stacks does Lampcode actually have".

**1. No router was installed, and no build has ever had URLs.** Neither `react-router-dom`
nor `@tanstack/react-router` is in `template.ts`, so every multi-view app the product has ever
produced switches views with a `useState`. No URL, so the back button does nothing, a refresh
returns the user to the start, and no view can be linked or bookmarked. The four-view CRM and
every dashboard are built this way. The prompt now requires real routing for any app with more
than one view.

**2. The model CAN bring a package, and the prompt was effectively telling it not to.**
`installExtraDependencies` (`e2b-service.ts:554`) reads the dependencies out of the model's
generated `package.json` and installs them BEFORE the dev server starts — up to
`MAX_EXTRA_DEPS` (12), registry names only, validated against `NPM_NAME_RE` so a URL or git ref
cannot get through. It exists precisely because `package.json` is in `BAKED_FILES` and a
declared `recharts` was being silently dropped. But the manifest block read "AVAILABLE IN THIS
SANDBOX … plus EXACTLY the DB/auth libraries named below", which any model reads as a closed
set — so the install path almost never fired. The manifest now says the list is what is already
installed, not a hard limit, and states the declare-it-in-package.json contract. This is what
makes the routing rule deliverable with **no template rebuild**.

**3. Live drift, now fixed: the prompt imported a package that does not exist here.** The GSAP
block told the model `import { useGSAP } from "@gsap/react"`. `@gsap/react` is a SEPARATE
package — not in `template.ts`, and not a dependency of `gsap` (checked by installing the
pinned range and listing the tree). Every GSAP build following the prompt would have failed to
resolve that import. Replaced with `gsap.context()` inside `useLayoutEffect` with
`ctx.revert()` cleanup, which needs only `gsap`, plus a pinned/scrubbed timeline example since
that is the backbone of a scroll-driven site.

**4. Every GSAP plugin is free now, and we were using one of six.** `"gsap": "^3.12.5"`
resolves to **3.15.0**, whose package ships `ScrollTrigger`, `ScrollSmoother`, `SplitText`,
`MorphSVGPlugin`, `Flip` and `Observer` — the former Club plugins, free since 3.13. Verified by
installing the range and listing the files. The prompt mentioned only ScrollTrigger; all six are
now listed with what each is for.

**Follow-up when the template is next rebuilt:** bake `react-router-dom` in, so routing costs no
per-build install. Until then it goes through the runtime path, which adds seconds and can fail
on a registry hiccup.

## FERNWOOD — the colour and routing changes verified on a real build, 2026-10-04
One build against deploy `7505db4`, prompt deliberately silent about colour. Plant care
tracker, four views. 8 rounds, 17 files, planned 14, `check_page`/`check_types`/`run_tests`
all pass, $0.406, 629 s.

**The palette fix works, and works the way it was meant to.** The model wrote
`src/theme.css` and imported it after `./styles.css`, with a green palette —
`--primary: oklch(0.45 0.11 155)`, hue 155, real chroma — for a *plant* app, plus a full
`.dark` block. Not grey, and not an arbitrary colour either: it matched the product.

**Routing happened, but NOT the way the prompt asked, and the build log said why in the
model's own words:** *"react-router-dom isn't in the sandbox deps and package.json can't be
edited, so I'll implement a small history-based router (pushState + popstate)"*. It wrote a
competent `router.tsx` — context, `pushState`, `popstate`, scroll reset, a `Link` — so URLs
and the back button work. But the reason it hand-rolled one is that **the prompt contradicted
itself**: the npm manifest said "declare it in package.json and it is installed", while the
HARD RULES said "Do NOT emit package.json", in four separate places. The model obeyed the
prohibition, which is the right call when instructions conflict.

**Reconciled.** The rule now states what is actually true: the environment's package.json is
authoritative for scripts and config and anything you write there is ignored EXCEPT a
`dependencies` object, which IS read and installed before the dev server starts — and that is
the only supported way to add a package. Fixed in all four places; a grep for the old
prohibition returns nothing.

Lesson worth keeping: a capability the code supports and the prompt forbids is invisible until
a build is run and its log is read. `installExtraDependencies` has existed for a while and
almost certainly never fired.

## MCP now works on the OpenAI-compatible provider — 2026-10-04
The section below described the catalogue as unreachable. **That is fixed**; it is kept because
the diagnosis is still the reason the design looks the way it does.

Three changes, and the third was the one that actually gated it:

**1. MCP no longer switches provider.** `dispatcher.ts` used to resolve `modal && !mcpServers`,
so any connected server forced the dispatch to Anthropic. It now stays on whatever the plan
chose.

**2. Read-only tools are offered as ordinary functions and executed here.**
`buildReadToolDefinitions` (mcp-tool-classifier.ts) mirrors `buildWriteProxyDefinitions` for
tools the classifier marked `allowed`, with the same `serverSlug__toolName` naming. It does NOT
re-decide allow/deny — it reuses `allowed` exactly as `classifyMcpServers` computed it, so both
gateways permit an identical set and the classification cannot drift between them. The defs are
built only when `effectiveProvider === "modal"`; on Anthropic the connector still runs these
server-side and offering them again would duplicate every tool.

The executor was extracted to `src/mcp/call-tool.ts` and is now shared: reads and writes take
the same transport, timeout and error shape, so a fix to one is a fix to both. It never throws —
a tool failure is something the model should see and work around, not something that kills a
build whose code is already written.

**Safety is unchanged, and that was the point.** Writes still go through the approval-gated
proxies. Ambiguous tools (`name-pattern-no-match`) remain blocked on both paths — neither
readable nor proxyable, because a proxy would turn "we do not know what this does" into an
approvable action. Discovery failure still contributes nothing, so a flaky server is
unavailable, never open. `executeTool` checks `writeMcpRegistry` BEFORE `readMcpRegistry`, so a
name in both can only cost an extra approval prompt, never skip one.

**3. `build.ts` was emptying the list, and this was the real gate.**
`const mcpServers = provider === "modal" ? [] : [...]` — on every build, since every build runs
`provider=modal`. The two changes above would have done nothing without this. User-connected
servers now flow through on both providers.

`internalMcpServers` (Firecrawl, Exa) stays out of the Modal path **on purpose, as a cost
decision rather than a capability one**: those two attach to EVERY build, and each attached
server costs a discovery round trip plus its full tool list in every round's context. A
user-connected server is one the user asked for; these would be charged to builds that never use
them.

14 cases in `npm test` (`scripts/mcp-tools.test.ts`), weighted toward the safety boundary —
a destructive tool never appearing in the read set, the two sets being disjoint, an ambiguous
tool being in neither, a null `authToken` surviving so it cannot become an empty Bearer header,
and a tool whose server is no longer connected being dropped.

### VERIFIED END TO END on a real GitHub account — 2026-10-04
Both halves now, on `provider=modal`, against the live GitHub MCP server.

**Read path.** A build logged `resolved: ["github"]`, `readToolCount: 28`,
`writeProxyCount: 18`, and the model called `github__list_issues` twice unprompted.
Classification split the server's 46 tools correctly and automatically: `list_issues`,
`get_file_contents`, `list_commits`, `search_code`, `get_me` … allowed as
`annotation-read-only`; `create_repository`, `push_files`, `create_branch`,
`create_pull_request`, `merge_pull_request`, `delete_file`, `fork_repository` … all
`deny(annotation-destructive)` and therefore approval-gated. Everything the owner wants from a
vibe coder — make a repo, push, open and merge a PR, edit a file — is present, and on the
correct side of the gate without anyone enumerating them.

**The model did not invent data.** Told to fetch the repo's real issues and to say so if it
could not, it called `list_issues` for OPEN and CLOSED, got nothing, and wrote
`ISSUES: GitHubIssue[] = []` with a comment stating the repository genuinely has none.
Independently confirmed: `open_issues_count: 0`, and the seven items the API returns are all
pull requests, all closed.

**Write path, including approval.** Tested with a Socket.IO client that joins the session room
the way the frontend does — the eval harness is HTTP-only and could therefore only ever have
proven the timeout-deny. The prompt arrived with the right payload
(`github.create_repository`, `{name, description, private:false}`), was approved, and
`github__create_repository: 1` appears in `buildOutcome.toolCalls`.

The first attempt reached GitHub and GitHub refused it —
`403 "Resource not accessible by personal access token"` — which is the fine-grained-PAT
symptom, not a product failure. **Re-run with a classic token carrying `repo` + `workflow`:
both writes succeeded.** Two approval prompts fired in one build (`create_repository`, then
`create_or_update_file`), both were approved over the socket, both executed, and the result was
confirmed OUTSIDE the product by cloning the repository: it exists, it is public, it contains
`README.md` with exactly the requested line, and commit `4d0eda8` ("Add README.md via GitHub
MCP integration") is authored by the owner's account.

So the full chain is proven: model asks for a destructive tool → the build blocks → the user
approves over the websocket → the MCP call executes → the change lands on GitHub.

**Token guidance, learned the hard way.** Use a CLASSIC token. A fine-grained one must enumerate
the repositories it may touch, and a repository that does not exist yet cannot be enumerated —
so "create a repo, then push to it" is structurally awkward there, and creating one at all needs
account-level Administration: write. Classic needs `repo` (covers create/read/write/push/PRs)
plus `workflow` if generated apps carry `.github/workflows/` files, since a push containing one
is rejected without it. Do NOT grant `delete_repo`. Classic `repo` does reach every repository
the user owns, and the mitigation is the approval gate above, which is now measured rather than
assumed.

Again the model reported it honestly rather than claiming success: *"The GitHub
create-repository call was made and was approved, but GitHub rejected it … The repository was
NOT created, so no URL exists. Nothing is being pretended to have worked."*

**The test harness approves exactly one named tool** and denies everything else, so a model
reaching for an unrelated destructive tool cannot have it merely because a test is running.

**What this cost to find:** four layers, each only visible by running it — MCP forcing Anthropic,
`build.ts` emptying the server list, the creds envelope, and an expired token. None of them is
visible by reading the code.

## The MCP catalogue is built — and unreachable on the provider we actually run (SUPERSEDED — see above)
Relevant to any plan involving GitHub, deploys or reading logs agentically, so recorded before
that work is scoped.

`src/mcp/registry.ts` already carries 22 servers, **GitHub, Vercel and Railway among them**
(GitHub via `https://api.githubcopilot.com/mcp/`, described as "Create repos, manage issues,
open pull requests"). `integrations.ts` has the connect endpoints. So the catalogue is not the
missing piece.

The missing piece is the provider. `modal-gateway.ts` has **no MCP support at all**, and
`dispatcher.ts:311` resolves the gateway as:

```ts
options.provider === "modal" && !(mcpServers && mcpServers.length > 0) ? "modal" : "anthropic"
```

So connecting ANY MCP server forces the build onto Anthropic — and `ANTHROPIC_API_KEY` is not
among the Railway service's variables. Every build today runs `provider=modal`. **A user who
connects the GitHub MCP today does not get GitHub tools; they get a build that routes to a
provider with no credentials.**

That makes the whole "agentic GitHub + deploy + logs" direction gated on one choice, not on
feature work: either put Anthropic credit behind it, or teach `modal-gateway.ts` to speak MCP
(the OpenAI-compatible surface has no MCP concept, so this means calling the MCP servers from
our side and exposing them as ordinary function tools — the same shape the agentic build tools
already use). Not started; raised so it is decided before anything is built on top.

## Next.js: the template was never built, and its definition is 10 days stale
Recorded because "there is a Next.js template" is true and misleading. `template-nextjs.ts` and
`build-nextjs.ts` exist, dated 2026-09-23 — before every October fix. The image has **none** of
`.lampcode-tools`, playwright, `check-render.mjs`, `PLAYWRIGHT_BROWSERS_PATH` or vitest, so a
Next.js build would have `check_page`, `check_types` and `run_tests` all **unavailable**, and
none of three/gsap/motion/Radix/tsparticles either.

`classifyBuild` pins `framework` to `"react"` on purpose and its comment is explicit:
`NEXTJS_TEMPLATE_ID` being set in production is **not** a safe signal to re-enable on, because
it points at no real template. `selectTemplate` still returns `process.env["NEXTJS_TEMPLATE_ID"]
?? TEMPLATE_ID`, so flipping the classifier back on without building the image first yields a
sandbox that cannot boot: `npm run dev` with no Next.js, and a readiness poll on :3000 while
Vite serves :5173.

Activating it is: port the October fixes into `template-nextjs.ts`, add the 3D/animation/Radix
set, build it, verify in a live sandbox the way `verify-template.ts` does, then re-enable
detection. Blocked on `E2B_API_KEY`, which is not in the repo's `.env`.

## The import-install fix, verified — and what "done" is still missing, 2026-10-07
`ORCHARD`, a three-view reading list, against deploy `7fb6dfa`. 4 rounds, 12 files,
`check_page`/`check_types`/`run_tests` all pass, $0.359.

**The fix is confirmed by the model repeating the exact behaviour that broke three builds.**
It imported `react-router-dom` and emitted **no package.json again** — and this time the page
rendered. So the install no longer depends on the model remembering to declare anything;
`importedPackages` reads what the code actually imports. Prompt-level instruction had already
failed at this twice, which is why it was replaced with a mechanism rather than firmer wording.

**Staleness is wired and reads honestly.** `staleCheckPage/Types/Tests` are all 0, which is
correct for this build — one `write_files`, then all three gates, nothing written afterwards.
That proves the field populates and that a clean build reports clean. **It does NOT prove the
detection fires**: no build has yet written something after checking, so the non-zero path is
unobserved. Until one does, treat the counter as wired-but-unexercised.

**Template rebuilt 2026-10-07** (4m23s) with the Vite-error-overlay check in `check-render.mjs`,
verified in a live sandbox — eleven checks pass, and the baked script was read back to confirm
it carries the new detection. `verify-template.ts` now asserts that behaviour rather than the
filename, because a failed build silently leaves the last good image in place, which is how
`check_page` stayed broken for three weeks.

### The completion problem, stated properly — the next thing to build
Five symptoms the owner named (no independent ground truth, local correctness vs global
completeness, the agent writing its own exam, tests proving only what happened, completion
bias) are ONE structural fact:

> The agent is both the author and the examiner, and the exam is derived from the same
> understanding that produced the code.

If the understanding missed "notes persist", the code has no persistence, no persistence test
is written, every test passes, and the agent honestly believes it is done. **No test failed
because the missing feature produced no test.** That is Finding 4 exactly, and it is why
self-review cannot fix it: a blind spot cannot audit itself.

So an independent signal must come from somewhere whose CONTENT did not come from the agent's
understanding. There are four such sources: the user's own words (parsed by a pass that never
writes code, and from the RAW prompt — a plan is already the builder's interpretation and
repeats its blind spot), reality (the browser, the test runner, the type checker — which
Lampcode already has, but which only answer the questions they are asked), an adversarial pass
whose objective is to find the gap rather than finish, and the user (`ask_user`).

**And the completion signal is not "all checks pass".** It is: every requirement mapped to a
check that ran AFTER the last write, with three states kept apart — `proven`, `contradicted`,
and **`unverified`** (nothing covers it). The third is the one no tool reports today, and
"done" should mean `unverified = 0`, not `failures = 0`. Those are different claims and users
hear the second as the first.

Next, in order: requirement extraction from the raw prompt by a non-building pass, stored as
R1..Rn; evidence mapping from each gate and test file to the requirements it covers; and
`unverified` surfaced to the user as a first-class result. The staleness work above is the
foundation — a check that cannot date itself cannot be evidence.

One measured reason to keep the audit in CODE rather than the prompt: prompts do move behaviour
when they state a consequence (`check_types` went 3/10 → 11/11 that way), but the pull toward
declaring done is in the weights, so the counter must increment on its own rather than ask the
model to confess.

## THE COMPLETION AUDIT — built, and measured on two real builds, 2026-10-07
`src/verify/completion-audit.ts`. Two dispatches that cannot write a file:
`acceptance` turns the RAW prompt into checkable requirements, `audit` reads the finished
code and returns `proven` / `contradicted` / `unverified` per requirement with a cited file.
Both are their own agent types so their prompts cannot be confused with a builder's. Stored
in `build_outcome.completionAudit` with `unverifiedCount` lifted out; shown in the chat and
as a card in the workspace; scored by the eval as its own finding.

Why it is not just another gate: the agent is author AND examiner, and the exam derives from
the same understanding that wrote the code, so a requirement it never understood produces no
implementation AND no test and nothing fails. The audit's content comes from the user's own
words instead.

**Run 1 — LEDGER** (expense tracker, 3 views, deploy `8c8305e`). 7 rounds, 14 files,
page/types/tests all pass, $0.541, 228 s. **8 criteria extracted, 8 proven**, audit cost
$0.060. Every citation was checked BY HAND against the downloaded files, including the three
requirements that usually go missing: `MAX_ENTRIES = 200` with oldest-dropped-by-`createdAt`
and a test; an Escape listener attached only while the dialog is open (and it genuinely is the
only dialog); and `useState<Expense[]>(loadExpenses)` — a real load, not just a save. The
extractor kept the number "200" in the requirement text, which is the detail that makes such a
requirement checkable at all.

**Run 2 — `editor-undo`** (the eval task that produced Finding 4), label `audit-gap-test`.
8 rounds, 22 files, `check_page` pass, `check_types` pass, `run_tests` pass, the eval's own
`mustContain` checks pass, verdict `pass`, $0.465. 9 criteria: 8 proven, **1 contradicted**.

### Finding 6 — the audit's one non-proven verdict was WRONG, and convincingly so
It reported that `NotesView` named-imported `Preview` while `Preview.tsx` "only has
`export default`", that the prop names disagreed (`note` vs `html`), and that
`markdownToHtml` "is never called anywhere in the app". **All three are false.** Checked in
the delivered files: `export function Preview({ note }: { note: Note })` — a named export,
the prop matches, and `markdownToHtml` is called inside `Preview.tsx` itself.

So on the one build where the audit said anything other than "proven", it was a false alarm —
and the user would have been shown **NOT DONE over working code**. That is its own kind of
damage: an outside check that cries wolf gets ignored, and then it is worth nothing when it is
right. Note also that the claim was self-refuting against evidence already in hand — a named
import of a default-only export does not type-check, and `check_types` had passed.

**FIXED — a complaint must now quote the line it is complaining about**, copied verbatim from
the file it cites, and `parseVerdicts` looks that quote up in the real content (whitespace
normalised, minimum 12 characters, and it must be in the cited file, not merely somewhere in
the project). A quote that is not found downgrades the verdict to `unverified` while KEEPING
the reported text, so the user sees "nobody has shown this works" rather than either a false
accusation or silence. This is the same move that makes `proven` trustworthy — check the
model's claim against something it does not control — applied in the other direction. The
auditor prompt now states the lookup and its consequence outright, and says that if you cannot
copy a line showing the problem, you have not found the problem.

The false positive is kept as a regression case. 48 cases in `npm test`.

### What is proven and what is not — stated plainly
- Proven: extraction from the raw prompt; the auditor citing real files; citations that are
  truthful (verified by hand on 8 of 8 LEDGER verdicts); the storage, the chat lines, the
  frontend card, the eval finding; and that a build the agent's three gates all pass can still
  draw a non-proven verdict.
- **NOT proven: that the audit catches a real missing requirement.** Both builds genuinely met
  their briefs, so the one gap-shaped verdict it produced was wrong rather than right. Until a
  build that actually drops a requirement is audited, the gap-detection claim is untested.

### The staleness counter fired non-zero for the first time
`editor-undo` recorded `staleCheckPage: 1, staleCheckTypes: 1` — a write landed after each of
those gates, so both verdicts describe code the build no longer had. Yesterday's entry said
that path was wired but unobserved; it is now observed. The audit is handed each gate's verdict
labelled `(STALE — N write(s) landed after it)` rather than as a clean pass.

**Live-only on the frontend:** the workspace has never read `build_outcome`, so a reload after
a finished build loses the card although the audit is stored. Not built.

## CODE BLOAT: measured, and the one question a program can answer — 2026-10-07
The owner named two problems: AI skips a lot when reviewing large code, and AI code GROWS —
300 lines for a simple app, and repeated edits add new behaviour without cutting the old.
These are the free, deterministic half of the answer. Done first on purpose: the costly
model-pass half cannot be judged until there are numbers to judge it against.

### Why edits grow a project — the mechanism, not the vibe
`edit_file(old → new)` is **additive by nature**. The cheapest way to satisfy "add X" is to
insert X; removing the path X replaced requires knowing what just became unreachable, and
**the model cannot know that** — reachability is a whole-program property and an edit sees one
file. So the old implementation stays. One feature then has two implementations, both compile,
both pass the tests, `check_page` renders the new one, and **every gate says the app is fine**
while the next edit has to guess which is live.

And nothing measured it: `BuildOutcome` recorded `filesWritten` — a count of FILES, never of
SIZE — so "do edits bloat?" was not a question the data could answer. Unmeasured, unmanaged;
the same pattern as every other finding in this file.

**1. Churn is now recorded.** `noteChurn` in `tools.ts` at the two sites that hold both
versions: `edit_file` (exact — the replaced span out, the new text in) and `write_files` (whole
old file out, whole new file in, which is literally what that tool does, so the NET is the
figure that means anything there). `BuildOutcome.churn` carries `added`, `removed`, `created`,
`replaced`, `edited`. **`removed` near zero while `added` climbs is the signature** of an edit
bolting a new path on beside the old one.

**2. `src/verify/dead-code.ts` + a `find_dead_code` tool.** Deliberately NOT a model pass: this
is the one question in the area that a program answers exactly and a language model cannot
answer at all. Free, no sandbox, no arguments — it reads the file set the build already holds,
so it works on a cold sandbox and in the early rounds. Three rules, each picked for being hard
to get wrong: an import whose identifier appears nowhere else in its file; a NAMED export no
other file mentions; and that second rule where the symbol is a component, reported separately
as `never-rendered` because it is usually a view an edit replaced and left behind.

**It is advisory and never a gate, and that is a deliberate asymmetry.** The analysis is
textual, not a TypeScript program, and the response to a dead-code finding is DELETING code —
the most expensive thing to be wrong about. So every rule under-reports: default exports are
out of scope entirely (a default import can be renamed at the import site, so proving one
unreferenced needs module resolution, and being wrong deletes an entry point); entry files are
exempt (the framework consumes those); test files COUNT AS REFERENCES, so a symbol used only by
its own test is left alone, because deleting it also deletes a passing test.

### Precision — and the correction that the first measurement was too small
The first probe ran over the two projects downloaded earlier today, LEDGER (14 files) and the
`editor-undo` notes app (22 files): one finding, zero false positives. **Generalising from that
to "precision is good" was premature, and pointing the analyser at THIS repo proved it.**

On `src/` it reported `findDeadCode`, `CompletionAudit`, `requireAuth` and about twenty others
as unused imports while every one of them was plainly in use. Cause: `stripComments` matched
block comments with a non-greedy regex across the whole file, and a **glob inside a string** —
a double-star, slash, star — carries a block-comment opener. The regex treated it as one and
closed it at the next genuine terminator, **deleting 45% of `build.ts`**: 154,668 characters
down to 85,224. Every identifier used in the deleted region then read as unused. Nothing in
36 files of generated app code contained such a string, which is exactly why a small clean
sample is not evidence.

**Fixed** by replacing both regexes with a character scanner that tracks string state (`'`,
`"`, backticks, backslash escapes). It does not try to recognise regex literals, and does not
need to: outside a string `/*` can only be a comment, because `a / *b` is not valid
JavaScript. After the fix the same three identifiers count 2 occurrences each (import + use),
and the five remaining unused-import findings were each confirmed by grep to appear exactly
ONCE in their file — so they are real.

Two more things that probe caught:
- The 40-finding cap was truncating the SCAN, so the recorded tally understated a large
  project — 12 unused imports reported under the cap versus 31 once the scan ran to
  completion. Counting and reporting are now separate.
- 28 of the `unreferenced-export` findings on `src/` alone dropped to 9 when `scripts/` was
  included. That was the probe's fault, not the analyser's: it was given half a project.
  Worth knowing, because it is the failure mode to expect if this is ever pointed at a subset.

31 cases in `npm test`, the glob-in-a-string trap kept as a regression, and most of the rest
asserting that something which LOOKS dead is left alone.

**The one genuine finding on generated output** remains `MonthSummary` in LEDGER's
`src/lib/summary.ts` — exported, and appearing nowhere outside its own file (confirmed by
grep), so the `export` keyword there is unnecessary.

**3. The prompt, with the consequence attached** — the pattern that moved `check_types` from
3/10 builds to 11/11, which worked where merely naming the tool had not. Two additions:
a replace contract inside the write step ("when you change how something works, delete the old
way in the same edit … replacing is a deletion plus an insertion, not an insertion"), and a
numbered step 7 that states the failure outright — the old implementation still compiles, still
passes the tests, and check_page renders the new one, so every gate passes over two versions of
one feature.

**Reported, NOT scored.** The eval prints churn and the dead-code tally and fails nothing on
either. Nobody knows what a healthy net-lines figure looks like yet, and failing a build over a
regex's opinion would be setting a threshold before taking a measurement. `deadCodeCalled`
records whether the model ASKED, kept apart from what the scan found — a model that never looks
and a project that is genuinely clean are different facts.

### The 300-lines-for-a-simple-app half is largely SELF-INFLICTED
`APP_TYPE_EXPANSIONS` in `prompt-builder.ts` tells the model, for a "todo", to add priority
badges, filter tabs, sort controls, a count display, empty states, a keyboard shortcut and 4–5
seed tasks. **We are asking for the 300 lines.** Not changed yet, and a line budget would be the
wrong fix — it would make the model compress into unreadable code. The right signal is scope
creep against the user's actual words, and the completion audit already extracts those, so
`requirements = 5, shipped = 12` is computable. Deliberately deferred rather than bolted onto
the audit dispatch: that pass was just hardened against a false positive, and adding a second
objective to it is the same attention-dilution that makes big reviews skip things.

### THE FIRST FOLLOW-UP EDIT THROUGH THE HARNESS — 2026-10-07
Listed above since 09-28 as "not yet exercised". It is now. One edit against the LEDGER
project built earlier the same day, deploy `0533d35`: *"in the monthly summary view, replace
the per-category totals list with a horizontal bar chart — one bar per category, widest first,
with the amount at the end of each bar. Keep the existing colours."* The prompt says nothing
about deleting the old implementation **on purpose** — asking for it would be doing the new
prompt rule's job inside the test.

3 rounds, `edit_file` ×1, `check_page` pass, `check_types` pass, `run_tests` never (correct —
this is presentation), audit 5/5 proven, $0.394, 74 s.

| | |
|---|---|
| churn | **added 25, removed 23, edited 1** — net +2 |
| dead code | 0 unused imports, 0 never-rendered, 1 unreferenced export |
| `deadCodeCalled` | **false** |

**The churn measurement is accurate, verified against the real diff.** The before and after
projects were both downloaded and compared: `diff` reports 23 lines out and 25 in, in one file.
The counter said 23 and 25.

**The edit replaced rather than accumulated**, unprompted. The old stacked label-above-bar
markup is gone, not left beside the new horizontal row — confirmed by reading the diff, not by
asking the model. Net +2 lines for a real feature change.

**And it preserved every untouched file**, which is the other half of what "not yet exercised"
covered: `diff -rq` across the whole project reports exactly one file different
(`src/views/Summary.tsx`), plus a `.preview` sandbox artifact. Nothing else moved.

The 1 unreferenced export is `MonthSummary`, which pre-dates this edit — so the end-of-build
scan works independently of the model, which was the reason for running it unconditionally.

**The gap, stated plainly: `find_dead_code` was NOT called.** The model changed how something
works and did not ask, so prompt step 7 did not fire on its first outing. One build is not a
measurement — `check_types` also started at 3 of 10 before the consequence-stating wording
moved it to 11 of 11 — but it is the number to watch. Note also that this edit was an EASY case
for that tool: the replacement happened inside one JSX block, and the failure the tool exists
for is a whole component or module left orphaned. A harder edit is needed to test it properly.

### REVIEW AT SCALE — the spine is built, 2026-10-07
Why a model skips on a big PR, and none of it is the context window (a big PR fits):
1. **Effort per unit, not capacity.** Roughly fixed effort per response, so per-file attention
   falls as file count rises, and the output is a plausible SUMMARY that reads like a review.
2. **No ground truth for coverage.** The reviewer picks its own scope AND reports its own
   coverage, so "I reviewed the PR" is unfalsifiable. This is the completion problem again.
3. **No definition of what to look for**, so it defaults to generic advice about naming.
4. **The cost shape is wrong** if you send N files × full context, when most of a repo is
   irrelevant to a diff and free tools answer most of the questions.

The agreed design is the completion audit's spine with different checks: enumerate the units in
CODE (`git diff` hunks / AST — so coverage is countable and `unreviewed` is a first-class state,
exactly like `unverified`); a free deterministic pre-pass (tsc, this dead-code analyser,
file-size thresholds, changed-file-without-a-test); risk-rank by change size × blast radius ×
missing tests; then one small dispatch per unit carrying only that unit and its importers from
an import graph, so attention stays high and cost is LINEAR; every finding quote-corroborated
the way `parseVerdicts` already does; and honest partial coverage when the budget runs out
("12 units deep, 35 cheap only") rather than fake full coverage. Estimated $0.50–1.00 for a
50-hunk PR. The failure catalogue is this file's own measured findings.

**Built, in four files.** `src/verify/import-graph.ts` resolves every relative, `@/`-aliased
and extensionless specifier to a real path and inverts it into a fan-in map.
`src/verify/review-units.ts` turns a project into risk-ranked units and runs the free pre-pass.
`src/verify/code-review.ts` is the model half — one dispatch per unit, coverage accounting,
quote corroboration, budget. `src/verify/corroborate.ts` holds the quote check, now SHARED with
the completion audit rather than copied: two copies would drift and the weaker one becomes the
way through, the same argument as `src/mcp/call-tool.ts`.

Offered as `review_code(max_files?)`, handled before the sandbox check because it reads the
file set rather than the running app. The prompt says to use it when the person asks for a
review and NOT on the agent's own fresh work, where the three gates answer the same question
for far less. Its spend is added to `cumulativeCostUsd` — it dispatches per file inside the main
tool loop, so it is not in `result.costUsd` and a review would otherwise look free.

**Coverage is recorded, not asserted.** `BuildOutcome.review` carries `deep`, `total`,
`unreviewed`, `findings`, `dropped`, `costUsd`, and `formatReview` states coverage in its FIRST
line — because "no problems found" over a project where four of forty files got a real look is
the claim this exists to make impossible to state by accident. A unit whose dispatch failed is
`unreviewed`, kept apart from `cheapOnly`: the direct analogue of `unverified`.

**A finding whose quote is not in the file it cites is DROPPED and counted** — not downgraded,
which is where this differs from the audit on purpose. There, an uncorroborated complaint still
told the user "nobody has shown this works". Here the unit was reviewed either way, so an
unquotable finding is pure noise, and noise is what makes a review get ignored. The count is
surfaced: a high `dropped` means the reviewer is hallucinating and the review should not be
trusted.

#### Three false positives, each found by running it on real output
The spine was probed against the two downloaded projects (37 files) after each change, and
every round caught something that reading the code would not have:

1. **Template-owned files are not in the generated set.** The first broken-import rule reported
   `./styles.css` and `./lib/utils` as unresolvable in BOTH projects. Both are real — the E2B
   template writes them, and they are in `BAKED_FILES` so the model cannot overwrite them. The
   generated file set is never the whole project. Assets and template-owned paths are now
   excluded.
2. **Fan-in ranked `src/types.ts` first in both projects.** Fan-in measures the blast radius of
   a BEHAVIOUR change, and a type-only module has no behaviour however many files import its
   shapes — so the first and most expensive dispatch was going to the lowest-yield file in the
   project. Type-only modules are now ranked by size alone.
3. **`export const CATEGORIES = [...]` was called "untested logic".** A const holding a literal
   is data; nobody writes a test for a list of category names, and a finding like that teaches
   the reader to skim the rest. Logic now means a function or class, or a const initialised to
   one.

After all three, every remaining finding on those projects is genuine: the two state hooks and
both `storage.ts` modules export real logic that other files depend on with no sibling test,
plus the known dead `MonthSummary` export.

**One coupling deliberately avoided.** `review-units.ts` COPIES the template-owned list instead
of importing `isTemplateOwnedFile` — measured, that import pulls config, Redis and the E2B SDK
and made the module hang when loaded outside the server process. The drift risk is covered by a
case that reads `e2b-service.ts` as TEXT and asserts every path in its `BAKED_FILES` appears in
the copy. **That guard caught two missing paths on its first run** (`lib/utils.ts`,
`lib/queryClient.ts` — the Next.js root-level variants), which is exactly why it exists.

43 cases in `npm test` (`scripts/review.test.ts`), all three false positives kept as
regressions. **No review has been run against a real model yet** — the enumeration, ranking,
pre-pass, corroboration and report are covered by cases and by the probes above; the per-unit
dispatch and the `review` prompt are not.

## ROTA — THE AUDIT CAUGHT A REAL MISSING FEATURE, 2026-10-07
The thing listed above as the audit's one unproven claim. It is proven now, and by the
clearest case so far.

A deliberately hard build against deploy `43c0c36`: a staff shift planner, four views, a rule
engine enforcing overlap / 40-hour cap / 11-hour rest / 35-hour overtime flag, shifts crossing
midnight, tests for three named edge cases. 19 rounds, **21 files**, planned 17, $1.074, 498 s.

| | |
|---|---|
| `check_page` | **pass** |
| `check_types` | **pass** (`staleCheckTypes: 7`) |
| `run_tests` | **pass** — three test files |
| churn | added 1360, removed 124, created 20, replaced 2, edited 8 |
| audit | **11 proven, 3 contradicted, 4 unverified of 18** |

**Every gate passed and the app does not contain the feature.** `src/App.tsx` imports exactly
five things — React, react-router-dom, lucide icons and `ShiftForm` — and has two routes,
`/` and `/shifts/new`. `WeekGrid.tsx`, `StaffList.tsx`, `RulesPage.tsx`, `ConflictsReport.tsx`
and `RosterProvider` are **never imported by anything**. Verified by hand on the downloaded
files, not inferred: `grep` for all five across the project returns nothing outside their own
directories. The rule engine is written and its tests pass; nothing calls it from a page the
user can reach. The shipped app is a dashboard saying "No shifts scheduled" and a form.

The gates were all honest. The two routed pages render, the project type-checks, and the rule
engine's own tests pass — because tests import modules directly, which is precisely why a
passing suite says nothing about whether a feature is wired into the app.

**The audit said so, specifically and correctly**, naming `App.tsx` and each unmounted
component. That is the gap-detection claim this file has carried as untested since the audit
was built, and unlike Finding 6 the verdict was right.

### Finding 7 — the quote rule was discarding the findings that matter most
All seven non-proven verdicts were the same true finding, and **four were downgraded to
`unverified`** by the corroboration rule. Correctly, by its own logic: they assert an ABSENCE —
"App.tsx never imports WeekGrid" — and **you cannot quote a line that is not there.** So the
guard added that morning to stop false accusations was, by construction, throwing away the
shape that a forgotten requirement actually takes.

**Fixed.** A `contradicted` verdict may now be corroborated EITHER by a quote that is in the
cited file OR by `missing`: one identifier the auditor says is absent, confirmed by checking it
really is. An absence is exactly as checkable as a presence, only inverted, and a model cannot
fabricate an absence the file contradicts. It must be a single identifier — a phrase like "any
routing for the views" is unverifiable and gets no credit, or a model could corroborate
anything by being vague enough. Cases cover all four directions.

### Finding 8 — the dead-code analyser could not see four orphaned views
It reported 1 unused import and 3 unreferenced exports, and **none of the four dead views**,
because all four are `export default` — which it skips by design, since proving a default
export unreferenced needs module resolution and being wrong deletes an entry point.

**Fixed with a check that needs no resolution at all.** The review's import graph has already
resolved every specifier, so "no file in this project imports this FILE" is a fact about the
graph rather than a guess about a symbol. `prePass` now reports `orphan-file`, excluding entry
files and test files. On ROTA it flags all four views **plus `src/state/rosterState.ts`, a
duplicate of `rosterState.tsx`** — two implementations of one thing, which is the bloat pattern
from the other half of this work. Eleven free findings in total, no model call:

```
[orphan-file] src/views/WeekGrid.tsx  ConflictsReport.tsx  RulesPage.tsx  StaffList.tsx
[orphan-file] src/state/rosterState.ts
[untested-logic] src/state/rosterStateImpl.tsx   src/lib/storage.ts
[dead-code] src/lib/rules.ts ×2   shiftTime.ts   weeklyTotals.ts
```

**The free pre-pass alone would have told the user the four views they asked for are not wired
up.** That is the cheapest finding in this entire file.

### Two more things this run measured
**`staleCheckTypes: 7`.** Seven writes landed after the last `check_types`, so that passing
verdict describes code the build changed seven times afterwards. The counter fired non-zero
for the second time and far harder than the first.

**The review could not run: `Modal rate limit exceeded`** — twice, at 25 s and 27 s, and the
second time `build_outcome` was NULL, meaning the very first dispatch never returned. Chasing
that turned up a bug that has nothing to do with reviews and affects every build:

### Finding 9 — a 429 killed any build in under half a minute
`RATE_LIMIT` is in `FALLBACK_CODES`, so the dispatcher moves to the next tier — and waited
`Math.min(retryAfterMs, 10_000)`, **capping a delay the provider had set to 60 s at ten
seconds**. On Anthropic that cap is harmless, because tier 2 is a different model. On the
OpenAI-compatible path **both tiers resolve to the same endpoint**: the model name comes from
`LLM_MODEL_NAME`, not from `MODEL_TIERS`. So the "fallback" was a retry against the same
throttled endpoint, 10 s into a 60 s window, and after two tiers the build threw. That is the
25 s. **Every user build that met a 429 died inside half a minute instead of waiting it out**,
and because it failed before the first dispatch returned, it recorded no outcome to diagnose
from.

Fixed: `fallbackDelayMs` honours the provider's `retryAfterMs` for `RATE_LIMIT` (bounded at
65 s) and keeps the short cap for `MODEL_DOWN` and `UNKNOWN`, where the next tier really is a
different model and stalling buys nothing. It lives in `src/agents/retry-policy.ts` — its own
module with NO imports, because the cases for it first imported `dispatcher.ts` and `npm test`
started printing a Redis warning: a suite that needs no credentials had begun pulling config,
Redis and the model clients in to check one arithmetic rule. Same lesson as `review-units.ts`
copying the baked-file list. 6 cases.

One retry with a 20 s wait per throttled unit is also now in `reviewProject`: the review fires
one dispatch per file in quick succession, which is the shape providers throttle, and without
it a mid-review throttle turns every remaining unit into `unreviewed`.

**`review_code` has still not been exercised against a real model** — and chasing why turned
up something far more important than the review.

### Modal refused this account, 2026-10-08 (SUPERSEDED — the provider is Bedrock now)
Kept because the diagnosis is still how Findings 9–11 came about, and because the billing shape
described here is the reason the provider was switched at all. For where things actually stand,
read "MOVED OFF MODAL TO AMAZON BEDROCK" below.

A third review attempt failed the same way, but at **75 s instead of 25 s**, which confirms
Finding 9's fix by timing: it honoured the 65 s wait instead of capping at 10 s. Then the
decisive probe — the eval's SMALLEST task, `counter`, one file, previously $0.060 and 30 s:

```
✘ counter fail (72s, 0 files) — Modal rate limit exceeded
model spend: $0.000
```

**So this is not a review problem at all.** Every build fails, down to a one-file counter,
with nothing reaching the model. The Modal shared endpoint is refusing this account outright,
and it stayed refused across more than an hour and four separate runs. While that holds, no
user build can succeed.

What the owner needs to check, since none of it is visible from here: the **Modal dashboard's
shared-endpoint usage and billing**. Remember that **plan credits do not cover shared-endpoint
usage** — it is billed per token — so a lapsed payment method or a spend cap looks exactly
like a rate limit. Today's load is a plausible trigger: the ROTA build alone was 19 rounds plus
a plan, an extraction and an audit.

### Finding 10 — the gateway was deleting the provider's own explanation
Diagnosing the above was harder than it should have been, because `mapModalError` **threw the
response body away on exactly the two branches that most need it**: a 429 became the fixed
string `"Modal rate limit exceeded"` and a 401 became `"Invalid Modal proxy token"`, while the
body — already read and in hand at the call site — was discarded. So a spend cap, a concurrency
throttle and a revoked token were indistinguishable, and the text saying which was deleted on
the way past.

Fixed: every branch now carries the provider's message (truncated to 300 chars), and the 429
honours the **`Retry-After` header** instead of hardcoding 60 s. That guess is wrong in both
directions — a per-second throttle clears far sooner, and an hourly quota does not clear at
all, so waiting 60 s and retrying merely burns the attempt, which is what happened four times
today.

`parseRetryAfter` takes seconds or an HTTP date. One of its own cases caught a bug in it:
`Date.parse` is permissive enough to read `"1.5"` as a date in the past, which clamped to 0 and
would have meant "retry immediately" on a header we did not understand. Every HTTP-date form
carries a weekday or month name, so a letter is now required before `Date.parse` is tried.
8 cases.

### THE ACTUAL CAUSE — it was never a rate limit, 2026-10-08
Finding 10's fix paid for itself on the very first failure after it deployed. Modal's own body,
surfaced for the first time:

```
Modal rate limit exceeded: {"error":"Plan credits cannot be applied to shared endpoint
usage. Add a payment method or increase your spend limit"}
```

**It is a BILLING refusal wearing a 429.** Four runs across more than an hour each waited and
retried something that can never clear by waiting, and the sentence saying so was being deleted
on the way past every single time. This is the note already in this file — *Modal plan credits
do not cover shared-endpoint usage* — arriving as an HTTP status that means something else.

**What unblocks the product: add a payment method on Modal, or raise the spend limit.** Nothing
in this repo needs changing for builds to work again.

### Finding 11 — a 429 about money must fail fast, not retry
Mapping it to `RATE_LIMIT` was strictly harmful: it cannot clear, so every retry is spent and
the real cause stays hidden. `PAYMENT_REQUIRED` was **already in `GatewayErrorCode`** and is
NOT in `FALLBACK_CODES`, so a billing 429 now fails in about a second, carrying the provider's
own words and stating plainly that it is not load — instead of 75 s of pointless waiting and a
message that sends the reader looking for a traffic problem.

`BILLING_RE` is deliberately narrow (payment method, spend limit, credit, billing, insufficient
funds, quota exceeded, subscription) because the error in the other direction is worse:
misreading a genuine throttle as unpayable would stop a build that waiting would have fixed.
Cases cover both sides, using the real captured body.

392 cases in `npm test`; ROTA's three findings are all kept as regressions.

**Still unproven, and blocked on the PROVIDER rather than on code:** `review_code` against a
real model. Its deterministic half — enumeration, ranking, the free pre-pass, corroboration,
the report — is verified by cases and by probes against two real projects. The per-unit
dispatch and the `review` prompt need one run, and no provider has served one since.

## MOVED OFF MODAL TO AMAZON BEDROCK — 2026-10-08
Modal's refusal above cannot clear by waiting, so the provider was switched. Bedrock reached
by the SAME gateway, with no new code path: `modal-gateway.ts` already speaks any
OpenAI-compatible `/v1/chat/completions`, and Bedrock serves exactly that.

**The live config (Railway).** `LLM_ENDPOINT_URL` must end at `/openai`, because the gateway
appends `/v1/chat/completions` itself and Bedrock's documented path is
`/openai/v1/chat/completions`:

```
LLM_ENDPOINT_URL=https://bedrock-mantle.ap-southeast-2.api.aws
LLM_API_KEY=<long-term Bedrock API key — starts "ABSK", 132 chars, REGION-SPECIFIC>
LLM_MODEL_NAME=moonshotai.kimi-k2.5
MODAL_REASONING_EFFORT=off
LLM_PROVIDER_MODE=openai
```

**The endpoint's path differs between the two Bedrock surfaces, and the gateway appends
`/v1/chat/completions` to whatever you set.** `bedrock-mantle` serves `/v1/chat/completions`,
so its URL ends at the host. `bedrock-runtime` serves `/openai/v1/chat/completions`, so ITS
url would have to end at `/openai` — getting that wrong cost three rounds (Finding 12).

The `MODAL_*` trio is REMOVED. `LLM_* ?? MODAL_*` means the new names win anyway, but a stale
Modal URL in the dashboard invites exactly the wrong conclusion, and a later missing `LLM_` var
would fall back to a dead endpoint instead of failing.

`MODAL_REASONING_EFFORT=off` is not optional here. The default `"low"` sends a non-standard
`reasoning_effort` field, tuned for GLM-5.3, to a provider that never asked for it.

**Pricing needed a row, and the miss would have been silent.** `MODEL_PRICING` is an exact
lookup on `LLM_MODEL_NAME`, and on Bedrock that value is `global.moonshotai.kimi-k3`, which
does not match `moonshotai/kimi-k3`. A miss falls to `DEFAULT_PRICING` ($1.00/$4.00) with only
a warning — every build costed at about a THIRD of its real price, taking the
`MAX_BUILD_COST_USD` guard and the user's deducted credits down with it. All three CRIS
profile ids are rows now. Bedrock's published cache rates are exactly `CACHED_INPUT_RATIO`
(1/10) and `CACHE_WRITE_RATIO` (1.25x) of the base, so `computeUsage` is unchanged.

### Finding 12 — a wrong URL path arrived as HTTP 200, and the stream parser ate it
Three rounds were lost to a log line that said the opposite of the truth. Every build reported
`toolCallsMade: 0`, whose message reads *"this model or endpoint does not do tool calling"* —
so the suspicion went to the model. The real sequence:

1. The endpoint URL was missing its `/openai` segment, so every request hit a route Bedrock
   does not serve.
2. AWS answered `{"Output":{"__type":"com.amazon.coral.service#UnknownOperationException"}}`
   — **with HTTP 200**, so `mapModalError` never fired.
3. The SSE loop reads only lines beginning `data:`, so a plain JSON body yielded NOTHING. The
   tell was `[stream] loop done: totalChunks=2 contentChunks=0 stopReason=undefined`, the 2
   being the generator's OWN trailing `usage`/`done` chunks. **totalChunks=2 means zero events
   parsed**, and that number is now the first thing to read on an empty reply.

Fixed in `958add5`: the gateway branches on content-type and parses the whole-completion shape,
and BOTH paths now log the body when nothing parses. That logging found the cause on its very
first run, having been added on a hypothesis that turned out to be wrong in its specifics —
which is the argument for keeping the provider's bytes rather than for any particular guess.

**A path can be probed with NO credential**, and this is worth remembering: a wrong path
returns the Coral envelope, while the right one returns a normal OpenAI-shaped 401. That
distinguished the two in seconds, against the live endpoint, with a junk token.

### Finding 13 — a 403 that is not about the credential
`mapModalError` called every 401/403 *"Modal rejected the proxy token"*. On a new AWS account
the 403 body was "Your account is currently being verified" — the key, the URL and the model id
were all correct and only the ACCOUNT was on hold. Naming the token sends the reader to
regenerate a key that was never wrong. `ACCOUNT_PENDING_RE` now says so, and says outright that
it is not a code problem; narrow on purpose, since calling a revoked key "pending" would have
someone waiting for something that never clears. `b17cc6f`, 6 cases on the captured body.

### IT WORKS — first green build on Bedrock, 2026-10-08
`counter` **passed**: 9 rounds, 1 file, 109 s, **$0.046**, audit `proven=7 unverified=0
contradicted=0`. The log lines that matter, because they are the ones that had never once
appeared:

```
[stream] loop done: totalChunks=5 contentChunks=2 stopReason=tool_use
[build] agentic mode produced 1 file(s) via its tools
```

**`stopReason=tool_use`, repeatedly, and files "via its tools" rather than the fence
fallback — tool calling on Bedrock is confirmed by a real build.** Every `toolCalls: 0`
recorded earlier was Finding 12's transport bug, so none of it was evidence about the model.
`totalChunks` now reads 5 / 12 / 31; the `=2` signature is gone.

**The working config is K2.5 on bedrock-MANTLE, not K3 on bedrock-runtime:**

```
LLM_ENDPOINT_URL=https://bedrock-mantle.ap-southeast-2.api.aws   # mantle is /v1, NOT /openai/v1
LLM_MODEL_NAME=moonshotai.kimi-k2.5                              # no prefix: K2.5 has no Geo/Global profile
```

### Finding 14 — the two Bedrock endpoints have SEPARATE quotas, and that is the whole fix
Two account-level walls were hit, and the owner separated them by testing both models in the
console playground — which is the right instrument, because it removes our code, our key and
our URL from the question entirely:

| model | playground | meaning |
|---|---|---|
| `moonshotai.kimi-k3` | `AccessDeniedException` | not entitled to this account at all |
| `moonshotai.kimi-k2.5` | `ThrottlingException`, "Too many tokens per day" | entitled; quota exhausted |
| `openai.gpt-oss-120b-1:0` | same throttle | entitled; quota exhausted |

So K2.5 was the model to use. But its **own card lists client-side tool calling only under
`bedrock-mantle`**, not under `bedrock-runtime` — so the switch to mantle was made for tool
calling. It fixed the quota as a side effect, and that is the reusable fact: AWS's own Chat
Completions page says *"Each endpoint has its own per-model token quotas"*, with separate
quota pages for runtime and mantle. **A new account's runtime quota sitting at 0 therefore
says nothing about mantle**, and the throttle that looked like a hard account-wide wall was
one endpoint's pool.

The gpt-oss probe still earned its keep: reaching a QUOTA error proved auth, URL and model
resolution were all correct while K3 was still returning AccessDenied.

**A route can be probed with no credential** — `bedrock-mantle.ap-southeast-2.api.aws/v1/chat/completions`
answered a junk token with a clean OpenAI-shaped `401 invalid_api_key`, confirming the region
serves mantle before anything was reconfigured. Same trick as Finding 12.

**Cost: K2.5 in Sydney is $0.618 / $3.09 per MTok** against K3's $3.00 / $15.00 — about five
times cheaper, and the `counter` build came in at $0.046 against $0.060 on Modal. Rates are
REGION-SPECIFIC (US $0.60/$3.00, several others $0.72/$3.60), so moving region without moving
the `MODEL_PRICING` row misprices every build.

**K3 remains unavailable** and would need AWS Sales. Nothing depends on it: the eval baseline
was measured on K3 via Modal, so the numbers below are not directly comparable to a K2.5 run,
and a fresh baseline should be taken before any prompt change is judged against them.

### K2.5 BASELINE — smoke tier, 2026-10-09. Cheaper, and MEASURABLY WEAKER
Label `k25-mantle-baseline`. The first comparable run on the new provider, against the
`kimi-baseline` smoke run of 2026-10-03 (K3 via Modal).

| task | K3 / Modal | K2.5 / Bedrock |
|---|---|---|
| counter | **pass** 3r 1f $0.060 | **soft-fail** 9r 3f $0.041 |
| todo | soft-fail 9r 7f $0.162 | soft-fail 14r 3f $0.086 |
| pricing-page | **pass** 5r 3f $0.125 | **soft-fail** 3r 1f $0.028 |
| form-validation | pass 8r 15f $0.278 | pass 5r 10f $0.061 |
| **all checks held** | **3/4** | **1/4** |
| spend | $0.626 | **$0.216** |

**4/4 built, 0 build failures, 0 harness errors, turn cap never reached** — the plumbing is
sound. `check_page` 4/4 and `check_types` 4/4, both perfect. So the drop is NOT infrastructure.

**It is the model.** Two tasks that passed on K3 now fail, and the failures are the shape that
matters most for this product: `counter` and `todo` BOTH miss the `PERSISTS` pattern entirely —
no localStorage, no backend, nothing — on prompts that ask for persistence. `todo` also drew an
`unverified` requirement from the completion audit. `pricing-page` collapsed from 3 files to 1.
A vibe coder whose apps forget their data on reload is a real product problem, not a scoring
quibble.

**And it is inconsistent run to run.** The same `counter` task PASSED on K2.5 the previous day
(9 rounds, 1 file, $0.046, audit 7/7) and soft-failed here with 3 files. One run is not a
measurement on this model.

Cost is the one clear win: **a third of K3's spend**, and mean rounds went UP (6.3 → 7.8), so it
is not winning by doing less. `run_tests` went unused on 3 of 4, against 1 of 4 before.

**What this means for the choice.** K2.5 works and is cheap, but the prompt and every number in
this file were tuned and measured on K3. Options, in the order worth trying: pursue K3 through
AWS Sales (it is the model the harness was built around); or try other tool-calling models on
`bedrock-mantle` and baseline them the same way; or accept K2.5 and re-tune the prompt against
THIS baseline rather than the K3 one. Do not compare a future change to the 10-03 numbers —
compare it to the table above.

### Finding 15 — the build socket gave up after seventeen seconds
Reported as "I tested and got no response". The build had in fact SUCCEEDED: 8 rounds, 3 files,
`check_page` pass, `check_types` pass, audit `unverified=0`, $0.119. What the owner saw was a
frozen screen.

```
14:45:23  build starts
14:46:35  Build WS disconnected  reason="transport close"
14:47:28  [storage] persisted 1 file(s)        ← the build carried on
          … rounds 5,6,7,8 → success
```

`createBuildSocket` set `reconnectionAttempts: 5`, which with its 1s/5s backoff is about
**seventeen seconds** before socket.io gives up PERMANENTLY. A build runs for minutes. The
global socket in the same file already used `Infinity`, so the 5 was accidental.

**The backend was never at fault, and neither was Redis.** `replayBuffer` and
`settleFinishedSession` already replay everything missed on rejoin — there was simply no
reconnect for them to fire on. Fixed in the frontend (`5a8da54`): `Infinity`, plus a toast on a
non-deliberate disconnect saying the build is still running, and one on reconnect saying it is
catching up.

**Correcting this file:** the Redis section above says build events are not buffered because
Redis is dead. **Redis has been alive since 2026-09-29** — verified 2026-10-09: the service
reads `SUCCESS`, Lampcode logs `[redis] connected` and `Socket.IO Redis adapter attached`
repeatedly, and there is not one `ECONNRESET`. Buffering works. Rate limiting should therefore
be re-checked too rather than assumed off.

### What was blocking it — superseded by the above, kept for the diagnosis
Every layer we control is verified by a real run. What remains is account-level and only the
owner can move it:

| | |
|---|---|
| account verification hold | **cleared by itself** |
| URL / key format / model resolution | **proven** — requests now reach model-level errors |
| `moonshotai.kimi-k3` | **403 "not available for this account"** — NOT a toggle, see below |
| `openai.gpt-oss-120b-1:0` | access GRANTED, but **429 "Too many tokens per day"** |

**There is no "enable this model" step any more, and looking for one wastes time.** AWS retired
the Model Access page in 2025 — serverless models in a Region are auto-enabled and
`PutFoundationModelEntitlement` is gone. The console's model catalog page for Kimi K3 in
`ap-southeast-2` shows the model, lists `function calling` among its capabilities, and offers
only "Open in playground": no request-access control exists to click. So the 403 is an
account-level entitlement or quota matter of the same family as the gpt-oss 429, not something
a setting fixes.

The gpt-oss probe is the proof the integration works: it cleared access control and reached a
QUOTA error, which cannot happen unless auth, URL and model resolution all succeeded.

**The quota is the bigger blocker and it is a known new-account trap.** That 429 arrived on an
account that had spent **$0.000**. Several AWS re:Post threads report the same: applied Bedrock
quotas sitting at **0** against defaults in the billions, often marked "not adjustable" so the
self-service increase is unavailable. The reported remedy is an **Account and billing support
case** asking for verification / quota correction — not a Service Quotas request.

**Do NOT settle for gpt-oss-120b as the model.** Its `bedrock-runtime` feature table omits
**client-side tool calling**, which the harness cannot work without; it is listed only under
`bedrock-mantle`. Kimi K3's card lists it on `bedrock-runtime`. Switching to gpt-oss to dodge
the access problem would produce a genuine `toolCalls: 0` and restart this whole diagnosis from
the beginning.

~~**STILL UNPROVEN: tool calling on Bedrock has never once succeeded.**~~ **PROVEN** — see the
green build above. What settled it was moving to K2.5 on `bedrock-mantle`, not anything about
K3.

## AN OUTSIDE CODE REVIEW, CHECKED CLAIM BY CLAIM — 2026-10-10
The owner brought an eight-point review of `917a3e4`. **Six findings were real, two were
wrong** — and the two wrong ones are the more instructive half, because both would have made
things worse if implemented on the strength of the report. Everything below was verified against
the current files first, the way Finding 6 should have been.

### Finding 16 — the repair loops' fixes were written to the sandbox and NOWHERE ELSE
The sharpest of the six, and a silent data-loss bug that has been live the whole time.

`allFiles` is mutated at three places — `build.ts` backend-crash fix, typecheck fix, browser
render fix — and all three are inside `finishPreview`, which is reached **only** from
non-awaited `.then()` chains (`void` + `setImmediate`). So it runs after `status: "success"`.
The only persist calls, `persistFilesAsWritten` and `uploadProjectFiles`, both run *before* it.

So: a build whose backend crashed, got repaired and now runs correctly stores **the crashing
version**. Restore prefers a live sandbox and falls back to storage, so the moment that sandbox
is reclaimed the user gets back the exact code those loops fixed. The 10-02 entry above says
files are persisted as they are written — true of `write_files` and `edit_file`, and these three
loops go through neither; they assign to `allFiles` directly.

**Fixed** by tracking whether any repair landed and, once, at the end of `finishPreview`,
re-persisting. Upserts are keyed on path, so it converges on the same stored project.

### Finding 17 — one build, three different cost figures
`usageUsd` was computed from `cumulativeCostUsd` **before** the acceptance-extraction and audit
dispatches added themselves to it, while `buildOutcome.costUsd` was taken after. The
post-completion repair loops above add to it later still, so they were in neither.

The report called this "the audit is never billed". **It is not** — `deductUsage` runs
per-dispatch inside `dispatcher.ts:753`, so the money is taken either way. It is a RECORDING
gap, and it matters because `billing.ts` sums that column for user-facing usage reporting:
the figure shown under-reported every audited build by roughly the audit's own $0.06, and
disagreed with the outcome stored beside it.

**Fixed**: `usageUsd` is now taken after the audit, and the post-completion reconciliation adds
the repair spend by read-modify-write rather than a blind set.

### Finding 18 — `checkAuth` reported a clean pass over ZERO files scanned
The security verifier selected route files by `p.includes("/routes/") || p.includes("route")`.
Lampcode's own generated Hono backend is **`src/server/index.ts`**, which matches neither — so
the check never opened the single most common place a generated app declares its API, and then
returned `status: "pass"` with the message *"All API route files apply auth middleware"*. An
app with no auth anywhere passed. Three more blind spots in the same function:

- `path.includes("auth")` exempted `author.ts` and `authorize-admin.ts` as "auth routes".
  **The first attempt at narrowing this reproduced the bug** — `auth` plus `[^/]*` still
  swallows `author`. The name must be the whole basename or be followed by a separator.
- The route regex required the literal `/api/`, so `app.route("/api", users)` — the standard
  Hono composition pattern — hid every route in the mounted file.
- Zero files scanned now reports **`skip`**, not `pass`. Same pass-vs-unavailable distinction
  the build gates keep; only `fail` drives the auto-fix loop, so this changes no gating.

`checkCORS` had two. A bare `cors()` defaults to `origin: "*"` and was invisible to a regex
looking for the literal — and it is the subject of hono's own advisory. Reported as `warn`
rather than `fail` **on purpose**: only `fail` spends a model dispatch, and nobody has measured
how often generated backends use a bare `cors()`, so failing on it would set a threshold before
taking the measurement. Same reported-not-scored stance as churn and the dead-code tally.
Separately, a case written for that work turned up that `Access-Control-Allow-Origin['":\s]+\*`
never matched `c.header("Access-Control-Allow-Origin", "*")` — the comma is not in the class, and
the call form is the one a Hono backend actually uses. A pre-existing hole, found by writing the
case rather than by reading the code.

**`security.ts` had NO cases at all** — the module behind the hard-block loop, unprotected by
anything that would notice it changing, exactly as `pricing.ts` was. It has 26 now.

### Finding 19 — `review_code` counted a truncated file as fully reviewed
`formatUnitForReview` cuts a unit at `UNIT_BYTES` (14 KB) and the loop then did `deep += 1`
regardless. So a 50 KB file read on its first 14 KB counted toward "Reviewed N of N in depth" —
in the one module whose entire purpose is that coverage is recorded rather than asserted.
`ReviewCoverage.truncated` is now carried as a subset of `deep`, disclosed in `formatReview`'s
**opening paragraph** (a caveat further down is a caveat nobody reads), and the unit prompt now
tells the reviewer outright that it is seeing part of a file and must not speak for the rest.

### Finding 20 — the criteria cap dropped requirements silently
`MAX_CRITERIA = 18` broke out of the extraction loop with no record, so a prompt whose later
requirements were never looked at still reported `unverified === 0`, which reads as "everything
you asked for is covered". `parseCriteria` now takes an optional stats out-param (optional so
every existing case keeps its signature), counts only genuinely new criteria past the cap, and
the count rides through to `build_outcome` as `completionAudit.criteriaDropped`.

**Correcting this entry's own first draft**, which said ROTA's exactly-18 meant it "very likely
lost requirements": the acceptance prompt itself says **"Between 2 and 18 requirements"**
(`prompt-builder.ts`). So a model returning 18 on a dense prompt is OBEYING the instruction, not
being truncated by the cap — the two numbers agree, and `MAX_CRITERIA` is a backstop against a
model that ignores the instruction rather than the thing shaping normal output. That is also why
the counter stays at 0 on a prompt with far more than 18 requirements in it. Whether 18 is the
right ceiling for a dense brief is a calibration question of the same family as Finding 3's
`BUILD_PLAN_MIN_WORDS`, and is **not** answered here.

### The two claims that were WRONG — and why implementing them would have hurt
**"`proven` is not fail-closed."** It already is, and has been. `parseVerdicts` requires a
citation that resolves to a file in the generated set or a real gate name, and anything else —
no citation, an invented path, a status outside the three, a criterion the auditor never
mentioned — falls to `unverified`. The function's own doc-comment is headed "FAIL CLOSED". This
is Finding 6's shape repeated by a different reviewer: a confident, specific accusation against
working code. Nothing was changed.

**"The audit should gate `status: success`."** It should not, yet. Finding 6 is the standing
counter-example: the audit's one non-proven verdict on `editor-undo` was entirely false, and
self-refuting against evidence already in hand. Gating on it would have shipped **NOT DONE over
a working app**. Its precision rests on one wrong verdict and one right one (ROTA); the probe
set in "Open" #4 is what has to come first. Recorded as a decision, not an oversight.

### Repo hygiene, since both were true
**`.env.example` was dated 2026-09-23 and actively misleading.** It advertised
`OPENROUTER_API_KEY` as "what calls Claude/DeepSeek" — a variable the codebase does not read —
documented Stripe billing that Paddle replaced, and said **nothing** about the `LLM_*` trio that
selects the provider. Somebody setting the project up from it would configure a dead key and no
model. Rewritten against `config.ts`, and `scripts/env-example.test.ts` now fails if a schema key
goes undocumented. Writing that guard caught three defaults I had guessed wrong in the rewrite
(`AGENTIC_MAX_TURNS` 12 not 40, `BUILD_PLAN_MIN_WORDS` 38 not 25, `USAGE_MARGIN_MULTIPLIER` 4
not 1), which is the argument for the check rather than against it.

**Nothing ran the repo's own gates.** `.github/workflows/` held one workflow, and `tsc --noEmit`
and `npm test` — the main gate and 438 free cases — had never blocked a merge. `ci.yml` now runs
typecheck, cases and build on every push and PR, plus an advisory `npm audit --omit=dev`. No
secrets, no sandbox, no model dispatch.

**`e2b-template.yml` was deleted, after checking it had never worked.** It triggered on
`e2b.Dockerfile` — an orphan this file already says never to edit — built a template named
`lampcode-react` rather than the live `lampcode-vite`, and baked a `--cmd`, which is the exact
double-Vite port race listed under "Things that will bite you". The deciding evidence was its
run history rather than a reading of the file: **8 runs, 8 failures, 0 successes, all on one day
in June 2026**, nothing since. Its only live reference was a stale comment.

That comment is fixed too. `e2b-service.ts` pointed the reader at "e2b.Dockerfile / e2b.toml"
for the template definition, i.e. straight into the trap listed first under "Things that will
bite you". It now names `e2b-template/template.ts` and `build.ts` and says the Dockerfiles are
orphans.

**The new CI ran on its own first commit and passed** (`0593315`), so the gates are live rather
than merely committed.

**Dependencies: 23 advisories down to ZERO.** `npm audit fix` within semver (`hono` 4.12.19 →
4.13.13, plus `tar`, `undici`, `ws`, `@hono/node-server`) cleared both criticals and all nine
highs. The hono advisories that actually applied here are the two CORS ones; the rest are
Lambda, Windows `serve-static` and `hono/jsx` paths this product does not use.

The last 7 looked like they needed `--force` major upgrades of tsup/tsx/drizzle-kit. **They did
not, and `--force` cannot even run here** — it exits `EOVERRIDE`, because `esbuild` is a DIRECT
dependency pinned to `0.28.0` *and* an `overrides` entry, and npm will not override a direct
dependency. All seven were one transitive `esbuild`, so the fix was a **patch bump of both
pins** to `0.28.2`. No major upgrade, no breakage: typecheck, 438 cases and the tsup build all
pass, and `npm audit` now reads 0.

Worth keeping: `--force` failing is not evidence that a fix needs a major version. Read what it
refused and why — here it named the conflict, and the real change was two characters.

`npm run db:generate` fails locally with *"Interactive prompts require a TTY"*. That is NOT the
esbuild bump — drizzle-kit parses `drizzle.config.ts` through esbuild successfully and then
stops at an enum-rename prompt it cannot show in a non-interactive shell. Pre-existing, and it
means a schema diff needs a real terminal.

### What is NOT done
- **The monolith split** (`build.ts` 3244 lines, `prompt-builder.ts` 2232, `e2b-service.ts`
  2051) — the review's eighth point, and true. Deliberately not started: it is a large
  behaviour-preserving refactor of the least-covered code in the repo, every October finding
  above lives in `build.ts`, and the cases that exist cover the pure modules rather than the
  orchestrator. It wants its own session and a plan, not the tail of a bug-fix pass.
### Two of the six are now PROVEN on a live build — ASTERISK, 2026-10-10
One build against `560fe95`, prompt deliberately requirement-dense to reach the criteria cap.
A reading tracker, three views, URL routing. 40 rounds (**`turnsExhausted: true`** — it hit the
40-turn cap), 18 files, planned 16, `check_page` pass, `check_types` pass, `run_tests` never,
audit **18 proven / 0 unverified / 0 contradicted of 18**, $0.1196, 324 s.

**Finding 17 is proven exactly, which is the one thing cases could not show.**

| | |
|---|---|
| `buildOutcome.costUsd` | 0.119619 |
| `usage_usd` | 0.478476 |
| `costUsd × USAGE_MARGIN_MULTIPLIER (4)` | 0.478476 |
| difference | **0** |

Before the fix those two disagreed by the audit's own spend — here $0.010022 × 4 = $0.0401 —
because `usageUsd` was snapshotted before it was added. One build now reports one cost.

**Finding 18 is proven on real generated output**, by running the fixed verifier against this
build's own 18 files rather than fixtures. It is a frontend-only app with no backend path at
all, and `checkAuth` returns **`skip` — "No API route declarations found to check for auth
middleware"**. Before the fix that exact input returned `pass` with *"All API route files apply
auth middleware"*, which is the false clean sheet the change exists to stop.

**Finding 20's counter read 0, correctly.** The extractor returned exactly 18 criteria, no
`[audit] criteria cap hit` line was logged, and `criteriaDropped` is absent. Reading the 18 back,
they cover the brief faithfully — R14 kept the "150 books" cap, R13 the Escape-and-focus-trap,
R18 the 390px. So nothing was dropped and the absence is right. **The non-zero path remains
unexercised**, exactly as the staleness counter was for a day: wired, honest, unobserved. See
the correction above for why it will rarely fire.

**Findings 16 and 19 were NOT exercised and remain unverified by a build.** No repair loop could
fire — `verifyPreview`, the typecheck gate and the browser-render gate all passed, which is the
good case and the one in which the persist path is dead code — and `review_code` was not called.
Finding 16 needs a build whose backend crashes or whose typecheck fails after delivery.

Two things this run measured in passing: `staleCheckPage: 2` and `staleCheckTypes: 2`, so both
passing verdicts describe code that changed twice afterwards; and the free dead-code pass found
1 never-rendered component plus 1 unreferenced export in the delivered app. `run_tests` was
never called despite R14 being a pure numeric cap and R11/R12 being validation logic — the
standing `check_types`-shaped gap, now in the test tool.

## Open, deliberately parked — raise these when the current work settles
1. ~~**`[memory-generator] failed: Could not resolve authentication method`**~~ — **RESOLVED
   2026-10-02.** The parked question was whether memory should route through the plan-based
   provider choice or be switched off while the key is absent. Neither: it needs no provider at
   all, because everything the old prompt asked a model to infer is already in the files. The
   log line is gone with it.
2. ~~**Billing overstates agentic builds**~~ — **RESOLVED 2026-10-03**, and it turned out to be
   wrong in BOTH directions, because the two providers' usage conventions are opposites.
   OpenAI-compatible `prompt_tokens` INCLUDES cached tokens, so costing them all as fresh
   **overstated** a multi-round build. Anthropic's `input_tokens` EXCLUDES cache reads and cache
   writes and reports them separately, so reading only that field billed cache reads — most of
   an agentic build's input — as **free**. Both gateways now normalise `promptTokens` to the
   real total with `cachedPromptTokens` and `cacheWriteTokens` as subsets, and `computeUsage`
   prices a cache read at a tenth and a cache WRITE at 1.25x (a premium, not a discount).
   15 cases in `npm test` (`scripts/pricing.test.ts`) — it previously had none, despite being
   the function behind the cost guard, the credits deducted, and any price set from `usage_usd`.
3. **`AGENTIC_MAX_TURNS=40` and `MAX_BUILD_COST_USD=3.0`** were raised on Railway on 2026-10-01
   for a long-running test. Revisit before opening the product to real users.
4. **The audit needs its own probe set — AGREED 2026-10-07, not built.** The one thing the
   completion audit has not shown is that it catches a REAL missing requirement, and waiting for
   a build to drop one is not a test you can run: you cannot make the model forget on demand.
   So mutate known-good output instead and keep the criteria fixed. Five mutations, each one a
   failure this repo has actually measured: strip the persistence (Finding 4); put an opaque
   background on an ancestor of the canvas (Finding 5); leave a keydown handler defined but
   never attached; delete a numeric cap while leaving everything around it (LEDGER R8); remove a
   conditional-warning branch (LEDGER R6). Run the UNMUTATED originals too — that half measures
   precision, which is what Finding 6 was, and a recall number alone would hide it.
   LEDGER's files and its 8 hand-verified verdicts are the natural first fixture.
   ~$0.06 per audit dispatch, so the whole set is well under a dollar and needs NO build.
   **Blocked on one thing:** it needs LLM credentials locally. The repo's `.env` holds only
   `E2B_API_KEY`, and Railway's API redacts variable values, so this could not be run on
   2026-10-07. `MODAL_PROXY_TOKEN` + `MODAL_ENDPOINT_URL` + `MODAL_MODEL_NAME` in a local `.env`
   unblocks it.

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
npm run typecheck   # tsc --noEmit, src/ and scripts/
npm test            # the repo's own cases — parser + eval scoring, costs nothing
npm run db:generate # drizzle-kit generate
```
`npm test` runs the repo's own cases — the vitest-output parser behind `run_tests`, the build
planner's gating and parsing, the project-memory derivation, and the eval scoring rules
(`scripts/*.test.ts`, plain tsx scripts, no runner). 180 cases, costing nothing and needing no
credentials. `tsc --noEmit` via `npm run typecheck` remains the main gate, and now
covers `scripts/` too.
