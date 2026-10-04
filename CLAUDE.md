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
