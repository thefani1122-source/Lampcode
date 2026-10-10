# Lampcode — Project Context

Read this every session. It holds what is TRUE NOW and the rules that stop known mistakes.

**`HISTORY.md` holds the evidence** — every dated measurement, every finding and the reasoning
behind each decision below. It is 160 KB and is **not** loaded automatically. Open it only when
you need the "why" behind something here, or before re-investigating anything that sounds like
it has been looked at before. It almost certainly has.

This split exists because this file reached 2,465 lines and was being read in full at the start
of every session, which cost roughly 40k tokens before any work began.

## What this product is

An AI vibe-coding platform: a user types a prompt and gets a working full-stack web app with a
live preview. Competitors: Lovable, Bolt, Replit. This repo is the **backend**; the frontend is
`vibe-coder-suite`.

## The stack — verified, trust this over any skill file

| Layer | Reality |
|---|---|
| Runtime | **Node ≥20.18.1** — NOT Bun |
| Framework | Hono (`src/server/index.ts`) |
| Build | tsup → `dist/` |
| Deploy | Railway (nixpacks) |
| LLM | OpenAI-compatible gateway → **Amazon Bedrock**, see below |
| Sandbox | E2B v2 SDK, template `lampcode-vite` (`e2b-template/template.ts` + `build.ts`) |
| Sandbox state | Redis, key `e2b:sandbox:{projectId}` |
| DB | Supabase Postgres + Drizzle |
| Realtime | Socket.IO |
| Frontend repo | React 19 + Vite + TanStack Router, Bun as package manager |

`src/deploy/pipeline.ts` is **dead code** — no live call path reaches it. Do not describe deploy
as working on the strength of that file.

## How a build runs

```
prompt → build.ts:runFastBuild()      orchestration, gates, repair loops
       → prompt-builder.ts            system prompt + conditional skills
       → dispatcher.ts → modal-gateway.ts   (OpenAI-compatible; name is historical)
       → e2b-service.ts               writes files, starts Vite :5173 / backend :3001
       → repair loops → completion audit → dead-code scan
```

**The agentic harness is the default** (`AGENTIC_BUILD_ENABLED`, true unless set to `"false"`).
The model drives: `write_files`, `edit_file`, `list_files`, `read_file`, `read_logs`,
`check_page`, `check_types`, `run_tests`, `fetch_reference`, `find_dead_code`, `review_code`.

**The deterministic repair loops run on BOTH paths**, after the agent finishes — they are gated
on the build's shape, not on the flag. Nothing there is scheduled for deletion. The
fence-parsing fallback protects the agentic path, not the old one; deleting it reintroduces a
fixed bug. (HISTORY: "the repair loops are SHARED".)

## Live provider config — Railway

```
LLM_ENDPOINT_URL=https://bedrock-mantle.ap-southeast-2.api.aws
LLM_API_KEY=<Bedrock API key, starts "ABSK", REGION-SPECIFIC>
LLM_MODEL_NAME=minimax.minimax-m2.5
LLM_MAX_OUTPUT_TOKENS=8000
LLM_PROVIDER_MODE=openai
MODAL_REASONING_EFFORT=off
```

Rules that cost days to learn:

- **The gateway appends `/v1/chat/completions` itself.** `bedrock-mantle` serves `/v1/...` so
  its URL ends at the host; `bedrock-runtime` serves `/openai/v1/...` so ITS url must end at
  `/openai`. A wrong path returns AWS's Coral envelope **with HTTP 200**, which the SSE parser
  reads as an empty reply and the logs blame on the model.
- **`[stream] loop done: totalChunks=2` means ZERO events parsed** — the generator always emits
  its own trailing `usage`/`done`. Read that number first on an empty reply.
- **A route can be probed with no credential.** A wrong path gives the Coral envelope; the right
  one gives a normal OpenAI-shaped 401.
- **`MODEL_PRICING` is an exact lookup on `LLM_MODEL_NAME`.** A miss falls to
  `DEFAULT_PRICING` ($1/$4) with only a warning, mispricing every build and the cost guard with
  it. Add a row before switching models. Rates are region-specific.
- **The two Bedrock endpoints have SEPARATE per-model quotas.** A quota of 0 on runtime says
  nothing about mantle.
- **`LLM_PROVIDER_MODE=openai` forces every build to this gateway.** Without it the provider is
  chosen PER PLAN, so an admin or paid account silently gets Anthropic.
- `MODAL_REASONING_EFFORT=off` means "send no reasoning field". Measured 2026-10-10: setting it
  to `low` changed no verdict, cost slightly more, and doubled one task's rounds. Leave it.

### Model availability on this AWS account — settled 2026-10-10

The account reaches **38 open-weight models** on mantle (Kimi, MiniMax, Qwen, DeepSeek, GLM,
Mistral, Gemma, Nemotron, gpt-oss). Every one that was probed supports tool calling.

**Every premium model returns `403 "not available for this account"`** — GPT-5.4/5.5/5.6,
GPT-6.x, Grok 4.7, and **Claude Sonnet 5.5**. The model IDs are valid (a wrong one gives 400),
so this is entitlement, not config.

AWS's retirement notice names the actual remedies, and they are NOT support cases:
- **Marketplace-served models (OpenAI, xAI): a user with Marketplace permissions must invoke the
  model ONCE** — e.g. in the console playground — and it is then enabled account-wide.
- **Anthropic models: submit use-case details** (a one-time form).
- An IAM policy or SCP can also restrict access.

So opening GPT 5.5 in the playground once should unblock it for the API too. Until the owner
does that, M2.5 is the choice. **Anthropic at launch** either goes through that form, or through
the Anthropic direct API, which `dispatcher.ts` already supports for the paid tier.

### Measured model comparison (smoke tier, same 4 tasks)

| model | all checks held | spend |
|---|---|---|
| Kimi K3 (Modal, no longer reachable) | 3/4 | $0.626 |
| Kimi K2.5 (Bedrock) | 1/4 | $0.216 |
| **MiniMax M2.5 (current)** | **2/4** | **$0.103** |
| Devstral-2 123B | **0/4** (2 outright fails) | — |

Every "11/11" and "20/20" number in HISTORY was measured on **K3**, which this account can no
longer reach. Do not compare a change against those. Compare against the M2.5 baseline.

## Current state

- **`WAITLIST_MODE` defaults to true.** Blocks `/api/build/fast` for non-admins and
  `/paddle/config` for everyone. Open the product with `WAITLIST_MODE=false` +
  `VITE_WAITLIST_MODE=false`. Admins bypass the frontend gate via `VITE_ADMIN_EMAILS`, which
  must mirror backend `ADMIN_EMAILS`.
- **Rate limiting is VERIFIED working** (100 req / 60 s, Redis-backed, `app.use("*")`), and a
  forged `X-Forwarded-For` does not reset the bucket. The old note that it is "entirely off" is
  superseded — that was true only while Redis was dead.
- **Redis is alive** and lives in the **`honest-endurance`** Railway project, not next to
  Lampcode. Cross-project traffic goes over the public TCP proxy.
- **`AGENTIC_MAX_TURNS=40`, `MAX_BUILD_COST_USD=3.0` — measured, leave them.** A real build hit
  40/40 rounds while using 4% of the cost ceiling. The turn cap is binding; lowering it ships
  unfinished apps. The risk to watch is the opposite one.
- **The preview Supabase project is PAUSED**, so a generated app's server-side persistence
  cannot actually work.

## Things that will bite you

1. **Two orphan Dockerfiles.** `/e2b.Dockerfile` and `/e2b-template/e2b.Dockerfile` are legacy.
   The live template is built from `e2b-template/template.ts` via `Template.build()`. Editing a
   Dockerfile has no effect.
2. **Never generate `src/styles.css`, `vite.config.ts`, `tsconfig.json`, `index.html`,
   `package.json`, `vitest.config.ts`, `vitest.setup.ts`** — the template owns them
   (`BAKED_FILES`). A `dependencies` object in a generated `package.json` IS read and installed;
   everything else there is ignored.
3. **No CMD in the template.** The backend starts Vite itself; a baked CMD causes a port race.
4. **Prompt-vs-reality drift is the #1 bug class here.** The prompt hardcodes package lists that
   drift from what `template.ts` installs. Touch one, check the other.
5. **The Python path is real** — FastAPI/uvicorn on :3001, detected from the generated files. Do
   not remove it.
6. **After ANY template build, run `cd e2b-template && npx tsx verify-template.ts`.** A green
   "Template built" has proved nothing twice; a failed build silently leaves the last good image
   serving, which is how `check_page` stayed broken for three weeks.
7. **Node resolves a bare specifier relative to the IMPORTING FILE.** Sandbox-side scripts must
   live in `/home/user/.lampcode-tools`, and a scratch script outside the repo must import
   `undici` by absolute path.
8. **`/health` returns 200 from the OLD container during a rolling deploy.** It is not a signal
   that a change is live — poll Railway's deployment status to `SUCCESS` before verifying
   anything or starting an eval.
9. **Importing `e2b-service.ts` outside the server process hangs** (it pulls config, Redis and
   the E2B SDK). `review-units.ts` copies its baked-file list instead, guarded by a case that
   reads the file as TEXT.
10. **`selectTemplate` deliberately ignores `NEXTJS_TEMPLATE_ID` / `TANSTACK_TEMPLATE_ID`.**
    Those templates exist and BOOT, but predate every October fix and carry no `check_page`,
    `check_types` or `run_tests`. Re-enabling needs a rebuilt, verified image first.

## What makes this product different — and why it is currently invisible

The build loop is table stakes; every competitor has one, on better models. Three things here
are genuinely unusual:

1. **The completion audit** (`src/verify/completion-audit.ts`) — the user's own words turned
   into checkable requirements by a pass that cannot write code, then each one marked `proven` /
   `contradicted` / **`unverified`**. On one build it correctly reported that four views the
   user asked for were never wired into the app, while all three gates passed.
2. **`build_outcome`** — every build records which gates ran, what they said, rounds, churn,
   cost, and whether a verdict went stale.
3. **Free deterministic checks** — orphan files, dead code, and a written-but-never-imported
   stylesheet (which silently leaves an app on the template's greyscale tokens).

**None of this is visible to a user today.** The audit card was removed from the UI because its
language was written for a maintainer. The measurement is unchanged and still stored; only the
audience is missing. That is the gap worth closing before more infrastructure.

Verified capability, so nobody re-investigates: the agent can see its own page, type-check, run
tests, surgically edit, plan long builds, install packages it imports, and drive the GitHub MCP
through an approval gate end to end.

## Working rules

Follow `.claude/skills/investigate-confirm-fix`:

1. **Investigate first.** Read the current file. Do not act on what a report claims — more than
   one confident, specific outside claim has turned out to be false against working code.
2. **Report and wait.** Findings, root cause, exact plan, risks. Stop for approval before
   editing.
3. **Change only what was approved.** No drive-by refactors or opportunistic cleanup.
4. **Verify.** `npm run typecheck` and `npm test`. Report per-change status honestly, including
   what you could not verify.

**A correct no-op is a success.** **Never claim something is done when a step remains** — name
the step.

**Do not spend the owner's money without being asked.** Builds and eval runs are real spend on a
pre-launch budget. Measurement is valuable; unrequested measurement is not.

**Record new findings in `HISTORY.md`, not here.** This file only changes when something it
states stops being true.

## Commands

```bash
npm run dev          # tsx watch, loads .env
npm run build        # tsup → dist/
npm run typecheck    # tsc --noEmit, src/ and scripts/
npm test             # ~440 cases, costs nothing, needs no credentials
npm run db:generate  # drizzle-kit generate (needs a real TTY)
npm run eval -- --tier smoke --label x    # REAL builds, real money
npm run eval:report -- --diff old.json new.json
npm run audit-probe  # completion-audit probe set, ~$0.02, no builds
```

`npm test` is the free gate and CI runs it on every push along with typecheck and the build.
The eval harness signs itself in from `EVAL_EMAIL` / `EVAL_PASSWORD` /
`EVAL_SUPABASE_ANON_KEY`; the account must be an admin while `WAITLIST_MODE` is on.
**Never edit an existing eval task's prompt** — it makes every stored run incomparable.
