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
| Runtime | **Node ≥20.19.0** — NOT Bun. The floor is a hard one, see bite #13 |
| Framework | Hono (`src/server/index.ts`) |
| Build | tsup → `dist/` |
| Deploy | **Railway** again (new account, $5 credit), Railpack from `main`; `Dockerfile` and `render.yaml` are portable fallbacks |
| LLM | OpenAI-compatible gateway → **Azure AI Foundry**, see below |
| Sandbox | E2B v2 SDK, template `lampcode-vite` (`e2b-template/template.ts` + `build.ts`) |
| Sandbox state | Redis, key `e2b:sandbox:{projectId}` |
| DB | Supabase Postgres + Drizzle |
| Realtime | Socket.IO |
| Frontend repo | React 19 + Vite + TanStack Router, Bun as package manager |

**There is no deploy today.** `src/deploy/pipeline.ts` was deleted 2026-10-11: every one of its
methods returned a hardcoded `success: false`, so `deploy()` could only ever fail, and it fired
progress events from 5% to 100% while doing nothing. Only `src/deploy/smoke.ts` remains — real,
and imported by nothing yet.

**The deploy decision is settled: the user's OWN Vercel/Railway, never Lampcode's account.** And
the plumbing for it already exists and is proven — `vercel` is in `src/mcp/registry.ts`
(`https://mcp.vercel.com`, bearer token), `callMcpTool` is a real generic MCP client, and the
agent has driven the GitHub MCP end to end through the approval gate. So deploy is not a build
from scratch; it is teaching the existing path to deploy and then verifying the URL.

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
`check_page`, `check_types`, `run_tests`, `fetch_reference`, `find_dead_code`,
`find_wiring_gaps`, `review_code`.

**The deterministic repair loops run on BOTH paths**, after the agent finishes — they are gated
on the build's shape, not on the flag. Nothing there is scheduled for deletion. The
fence-parsing fallback protects the agentic path, not the old one; deleting it reintroduces a
fixed bug. (HISTORY: "the repair loops are SHARED".)

## Hosting and provider config — moved off AWS, 2026-11-27

**The AWS account was suspended for security reasons.** That took BOTH the backend host and the
Bedrock gateway with it, so every Bedrock fact below the fold in HISTORY is now history, not
config. MiniMax M2.5 is **not reachable**.

**Azure cannot host this.** The $200 Azure credit is real and usable, but the subscription's
compute quota is **0** and cannot be raised:

| quota | region(s) checked | limit |
|---|---|---|
| `standardBsv2Family` (VM cores) | eastus, eastus2, westus2, centralindia | 0 |
| App Service B1 | eastus | 0 |

Azure rejects the quota-increase request itself — *"not eligible for quota adjustment, consider
upgrading your subscription"* — which Microsoft documents as expected on free/trial offers, and
which it also applies to Container Apps. Do not spend another day on this; it is an offer-level
restriction, not a region or SKU problem.

**So: host elsewhere, spend the Azure credit on the model.** That split is better than it
sounds — the whole $200 goes to inference and evals instead of burning on a box.

### Host — Railway (again), on a new account

The owner opened a second Railway account with $5 of credit, which by his own measurement lasts
him more than a month, and connected `thefani1122-source/Lampcode` to a service named
`lampcode-api` in project `radiant-benevolence`. Builder is **Railpack**, not the Dockerfile:
build `npm ci && npm run build`, start `npm start`, healthcheck `/health`.

First deploy failed — see bite #13. Build and deploy both went green and the **healthcheck**
failed, which looks like networking and was not: the process was dying at boot on Node 20.18.1.

The other hosts were researched and the work is kept, because this is the fourth host in a week:

- **`Dockerfile`** at the repo root — runs on Northflank, Koyeb, Cloud Run, Fly or any VM. This
  is the real insurance; the next migration should be an afternoon.
- **`deploy/NORTHFLANK.md`** — free Sandbox, 2 services + 1 database, $20/mo of resources,
  always on, card verified not charged. The best free option if Railway's credit runs out.
- **`render.yaml`** — no card at all, 512 MB, sleeps after 15 idle minutes.
- `deploy/vm/` — the VM kit, provider-neutral.

Rejected, with the reason, so nobody re-checks them: **Azure** compute quota 0 and unraisable;
**Zeabur** shuts down 31 Dec 2026; **Hugging Face Spaces** now charges for Docker Spaces;
**Back4App** free URLs live 60 minutes per deploy; **Google Cloud** Always Free still needs a
billing account; **Koyeb** scales to zero; **Oracle** no capacity.

**Verified 2026-11-27/28 in a clean container:** `npm run build` succeeds (1.39 MB bundle,
~200 ms); `npm ci --omit=dev` installs 183 packages; on production dependencies only and with
**no environment at all**, the server boots and answers `/health` **200** under Node 20.19.0 and
22. `REQUIRED_VARS` only warns, so a deploy goes green before any secret is filled in — which
also means **a green deploy is not evidence the app is configured**. The ephemeral disk needs no
work: project files already sync to Supabase Storage. **The Docker image has never been built** —
this container has the Docker CLI but no daemon, so the two stages were run by hand.

`/health`'s `commit` reads `GIT_COMMIT` before falling back to `git rev-parse`, because an image
has no `.git`. On Railpack the git fallback works; in a container, pass the build argument.

### Model — Azure AI Foundry, OpenAI-compatible route

```
LLM_PROVIDER_MODE=openai
LLM_ENDPOINT_URL=https://<resource>.services.ai.azure.com/openai   # ends at /openai
LLM_API_KEY=<Foundry key, sent as Authorization: Bearer>
LLM_MODEL_NAME=<the DEPLOYMENT name, not the catalogue name>
LLM_MAX_OUTPUT_TOKENS=8000
MODAL_REASONING_EFFORT=off
```

Bearer auth is what the gateway already sends, so the provider swap is **config only — no code
change**. Cognitive Services quota is separate from compute quota, which is why Foundry works on
this subscription when App Service does not.

**NOT YET VERIFIED:** no request has been made against the Foundry endpoint from this codebase.
Probe it before trusting it — a wrong path is the failure that cost days on Bedrock.

**`MODEL_PRICING` has no row for the new model, deliberately.** The owner deferred it: this is a
testing run, not a billing one. The consequence is live and should not be forgotten — the model
bills at `DEFAULT_PRICING` ($1/$4) and **`MAX_BUILD_COST_USD` is enforced against that wrong
number**. Add the row before any eval whose cost figures are meant to mean something.

### Rules that cost days to learn — still true, provider-independent

- **The gateway ALWAYS appends `/v1/chat/completions`** — `modal-gateway.ts:365` interpolates it
  unconditionally, so `LLM_ENDPOINT_URL` must stop one level short or the suffix doubles. Azure's
  OpenAI-compatible route is `{endpoint}/openai/v1/chat/completions`, so the variable ends at
  `/openai`, no trailing slash. A wrong path can return an envelope with **HTTP 200**, which the
  SSE parser reads as an empty reply and the logs blame on the model.
- **`[stream] loop done: totalChunks=2` means ZERO events parsed** — the generator always emits
  its own trailing `usage`/`done`. Read that number first on an empty reply.
- **A route can be probed with no credential.** A wrong path gives a malformed envelope; the
  right one gives a normal OpenAI-shaped 401.
- **`MODEL_PRICING` is an exact lookup on `LLM_MODEL_NAME`.** A miss falls to `DEFAULT_PRICING`
  with only a warning, mispricing every build and the cost guard with it.
- **`LLM_PROVIDER_MODE=openai` forces every build to this gateway.** Without it the provider is
  chosen PER PLAN, so an admin or paid account silently gets Anthropic.
- `MODAL_REASONING_EFFORT=off` means "send no reasoning field". Measured 2026-10-10: `low`
  changed no verdict, cost slightly more, and doubled one task's rounds. Leave it.

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
- **The preview Supabase is ACTIVE again** (checked 2026-10-14: both projects report
  `ACTIVE_HEALTHY`). The older note that it was PAUSED — and that a generated app's server-side
  persistence therefore could not work — is superseded. Free Supabase projects pause themselves
  after inactivity, so re-check rather than assume in either direction.
- **`LLM_PROVIDER_MODE=openai` means an `ANTHROPIC_API_KEY` alone changes nothing.**
  `build.ts` picks the provider BEFORE the key is ever consulted: `openai` → always the Bedrock
  gateway, `anthropic` → always Anthropic, `auto` → per plan (free → Bedrock, paid → Anthropic).
  So switching to Anthropic is two variables, not one. `auto` is the shape the owner described —
  M2.5 for free users, Anthropic for paying ones.

## Things that will bite you

1. **Three Dockerfiles, and only one of them is live for its job.** The root `/Dockerfile`
   builds the BACKEND image for the container host — that one is real. `/e2b.Dockerfile` and
   `/e2b-template/e2b.Dockerfile` are legacy and read by nothing: the sandbox template is built
   from `e2b-template/template.ts` via `Template.build()`, so editing either has no effect.
2. **Never generate `src/styles.css`, `vite.config.ts`, `tsconfig.json`, `index.html`,
   `package.json`, `vitest.config.ts`, `vitest.setup.ts`** — the template owns them
   (`BAKED_FILES`). A `dependencies` object in a generated `package.json` IS read and installed;
   everything else there is ignored.
3. **No CMD in the template.** The backend starts Vite itself; a baked CMD causes a port race.
4. **Prompt-vs-reality drift is the #1 bug class here.** The prompt's package lists are
   DERIVED from `template.ts` / `template-nextjs-ubuntu.ts` at runtime, and asserted by
   `scripts/npm-manifest.test.ts`. All three extractor regexes were silently broken until
   2026-11-24 and served a generic fallback that omitted hono, zod, ws, react-router-dom and
   every Radix primitive (HISTORY). Other prompt facts are still hand-written: touch one,
   check the other.
5. **The Python path is real** — FastAPI/uvicorn on :3001, detected from the generated files. Do
   not remove it.
6. **After ANY template build, run `cd e2b-template && npx tsx verify-template.ts`.** A green
   "Template built" has proved nothing twice; a failed build silently leaves the last good image
   serving, which is how `check_page` stayed broken for three weeks.
7. **Node resolves a bare specifier relative to the IMPORTING FILE.** Sandbox-side scripts must
   live in `/home/user/.lampcode-tools`, and a scratch script outside the repo must import
   `undici` by absolute path.
8. **`/health` can answer 200 from the OLD container during a deploy.** It is not a signal that
   a change is live — wait for the host to report the deploy finished before verifying anything
   or starting an eval. Its `commit` field is the real check, and in a container that field is
   only populated if `GIT_COMMIT` was passed as a build argument.
9. **Importing `e2b-service.ts` outside the server process hangs** (it pulls config, Redis and
   the E2B SDK). `review-units.ts` copies its baked-file list instead, guarded by a case that
   reads the file as TEXT.
10. **`selectTemplate` is FAIL-CLOSED, and Next.js is the default build.**
    `DEFAULT_BUILD_FRAMEWORK` is `nextjs`, so most builds ask for the Next.js template — and
    `selectTemplate("nextjs")` **throws** unless `NEXTJS_TEMPLATE_ID` matches
    `^lampcode-nextjs-ubuntu24(-…)?$`. A wrong or empty value fails every default build before a
    sandbox is even created. `selectTemplate("tanstack")` throws unconditionally, so
    `TANSTACK_TEMPLATE_ID` is dead weight wherever it is set. (This supersedes the old note that
    both IDs were ignored.)
11. **The `/api` proxy is a DEV-SERVER feature.** `template.ts` bakes
    `server.proxy['/api'] → localhost:3001` into `vite.config.ts`, so a generated app's
    relative `/api/...` calls work in the preview and **only** there — a production build has no
    dev server and nothing answers them. Fixed 2026-10-11 by routing every call through
    `API_BASE = import.meta.env.VITE_API_URL ?? ''` in the generated `src/lib/api.ts` (unset in
    the preview, so behaviour there is unchanged). If you touch either side, check the other:
    the prompt's `src/lib/api.ts` shape, this proxy, and `wiring.ts`'s `hardcoded-dev-host` rule
    all describe the same contract. The rule itself lives in ONE place —
    `API_BASE_CONTRACT` in `prompt-builder.ts` — and every block that serves a backend
    on :3001 interpolates it. Next.js deliberately does not: its Route Handlers are
    same-origin, so there is no base to point anywhere. `prompt-ceiling.test.ts` asserts
    per shape which side of that line it is on.

12. **The system prompt has a hard ceiling and the biggest build shape sits near it.**
    `MAX_SYSTEM_PROMPT_TOKENS` is 30,000 (93,000 chars) — a CEILING, not the size. Measured
    2026-11-28: Next.js fullstack + auth (the default) is **51,953 chars / ~16,800 tokens**;
    React/Vite + Hono + Supabase + auth is **88,685 / ~28,600**; frontend-only is **53,078 /
    ~17,100**. In every shape the two largest blocks are `REFERENCE MATERIAL — GUIDANCE ONLY`
    (26–39%) and `HOW TO BUILD` (13,781 chars, identical across shapes). Frontend-only costs
    almost as much as a fullstack Next.js build because it still carries the database, RLS and
    tenant-isolation blocks it cannot use — unbilled waste, and the first place to look if
    tokens per request need to come down.

    Nothing is shed or cut on a normal build, and
    it must stay that way: the reference section carries the `database-rls` and
    `supabase-rls` skill bodies, so shedding it routinely costs RLS guidance. Over the
    ceiling, `assembleSystemPrompt` drops the reference section WHOLE and keeps the
    contract — never the other way round, which is what it used to do (HISTORY, 2026-11-24).
    `projectMemory` and `projectManifest` are budgeted (8,000 / 12,000 chars) because both
    are generated here, grow with the project, and are recoverable — unlike the contract.
    If you add prompt text, run `npm test`: `scripts/prompt-ceiling.test.ts` fails when the
    contract is cut OR when an ordinary build starts shedding its reference section.

13. **Node must be ≥20.19.0, and 20.18.1 specifically is fatal.** `e2b@2.55.0` is CommonJS and
    does `require("chalk")`; `chalk@5.6.2` is ESM-only (`"type": "module"`). `require()` of ESM
    was only unflagged in **20.19.0** and **22.12.0**, so on anything older the process dies at
    boot with `ERR_REQUIRE_ESM` before it can listen, and the host reports a *healthcheck*
    failure — which reads like a network problem and is not one. Measured 2026-11-28 against the
    real `dist/` and `node_modules`: 20.18.1 exits 1; 20.19.0 and 22.23.5 both answer `/health`
    200. This cost a Railway deploy. **CI cannot catch it** — `npm test` never loads e2b's CJS
    entry, so the suite is green on a Node that cannot boot the server. The floor is now declared
    in `package.json` engines, the `Dockerfile`, `render.yaml` and both CI workflows; keep them
    in step.

14. **A throttled provider must be waited out, not failed over to.** `MODEL_TIERS` has two
    entries per agent, but on the OpenAI-compatible path both resolve to the SAME deployment
    (the model comes from `LLM_MODEL_NAME`), so the tier loop alone gives a 429 exactly one
    retry. Worse, Azure answers a token-rate 429 with `Retry-After: 3` — honest for a
    REQUEST-rate window, useless for a per-minute TOKEN budget. Measured 2026-11-28 from live
    logs: `delay: 3000` → `build_failed` 7 s later, and `delay: 16000` → `build_failed` 21 s
    later. `RATE_LIMIT` now retries the same endpoint up to `RATE_LIMIT_MAX_ATTEMPTS` times and
    treats the provider's hint as a floor to raise (`RATE_LIMIT_MIN_DELAY_MS`), never a ceiling
    to trust. **A 429 is a wait, not a failure** — if a build dies on one again, check those two
    constants before blaming quota.

15. **On a follow-up edit the framework comes from the FILES, not the classifier.**
    `detectFrameworkFromFiles` (in `framework-selection.ts`, kept out of the build route so its
    cases run without the server graph) decides which contract the next prompt carries: React/
    Vite gets the `API_BASE` rule because its backend is a second origin, Next.js deliberately
    does not. It used to test `app/layout.tsx || next.config.js`, and **the second half was
    dead** — the Ubuntu template writes `next.config.ts`. One missing `app/layout.tsx` and a
    Next.js project silently became "react" on its next edit. It now reads the config file in
    any extension, route-group layouts and pages, a Route Handler, and the `next` dependency.

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
4. **The hollow-app check** (`src/verify/wiring.ts`) — what RENDERS but does nothing: a button
   with no handler, a form that submits nowhere, a link to an undeclared route, a `fetch`
   against an endpoint the backend never defined. Free, deterministic, and the only thing here
   that answers the question the three gates cannot: a test imports its module DIRECTLY, so
   passing tests never prove the app wired that module in. Five of the seven kinds feed a
   repair loop that runs before the preview is shown; `orphan-endpoint` and `placeholder-text`
   are reported only, because their fix is a product decision. Measured on 93 hand-written
   files: 2 findings, both real bugs in the live frontend. (HISTORY, 2026-10-11.)

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
