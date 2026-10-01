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
too. Check `[build] agentic mode produced N file(s) via write_files` and the
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
URL and returns its JSON marker. Re-run that check after any template change — a green
`✅ Template built` proved nothing here twice.

Lesson: when a template build fails, every sandbox silently keeps running the LAST GOOD image.
Nothing downstream reports a stale template, so always read the build log to its last line.

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
