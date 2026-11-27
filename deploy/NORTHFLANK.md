# Hosting the backend on Northflank's free Sandbox

Written for one person with no money this month, a card that works for
verification but not for real charges, and three days already lost to cloud
quotas.

**No payment. A card is entered once, for verification only** — Northflank's own
FAQ: *"Am I charged when I enter my credit card? No — when you enter a card we
only verify the card."*

---

## Why here

Four hosts were tried or checked first, and each died for a different reason:

| host | what happened |
|---|---|
| AWS | account suspended — took the host **and** the Bedrock model with it |
| Railway | credits exhausted |
| Azure | compute quota **0**, and the quota request itself refused |
| Google Cloud | Always Free still needs a billing account; the $30 was the blocker |
| Oracle | no capacity, signup rejected |
| Zeabur | **shutting down 31 Dec 2026** — services start going offline 1 Dec |
| Hugging Face Spaces | Docker Spaces now need a paid plan; only static is free |
| Back4App | 256 MB, and since 15 Sep 2026 a free URL lives **60 minutes per deploy** |

Northflank's free **Sandbox** gives, from its own pricing page:

- **2 services, 2 jobs and 1 database**
- **up to $20/month of resources** on Northflank Cloud
- **"Always on, no sleeping"** ← the part Render's free plan cannot do

A database addon is included, so **Redis comes back for free** — which the app
has been running without.

### The one number to watch

The allowance is **$20 of resources a month**, not unlimited. At their rates:

| | plan | cost |
|---|---|---|
| the API | `nf-compute-50` — 0.5 vCPU, 1 GB | $12.00/mo |
| Redis | smallest addon | roughly $3–6/mo |

That totals somewhere near **$15–18 against a $20 ceiling** — it fits, but not
with much room. Start **without** the Redis addon, confirm the API is stable,
and add Redis after. The plan is named "no unexpected charges", so hitting the
cap should stop resources rather than bill you, but do not go looking for the
edge on purpose.

---

## 1. Deploy the service

1. Sign up at <https://app.northflank.com/signup> with GitHub, and add the card
   when asked. It is verified, not charged.
2. **Create a project** (pick the region nearest you).
3. **Create a service → Deployment → Build from Git repository**.
4. Repository `thefani1122-source/Lampcode`, branch `main`.
5. Build type: **Dockerfile**, path `/Dockerfile`.
6. Compute plan: **nf-compute-50** (0.5 vCPU, 1 GB).
7. Networking: expose port **3000**, protocol HTTP, publicly accessible.

The `Dockerfile` at the repo root is written for exactly this and is not tied
to Northflank — the same image runs on Koyeb, Cloud Run, Fly, or any VM. After
losing three hosts in a week, that portability is the point.

Optional but worth it: under the build settings add a build argument
`GIT_COMMIT` so `/health` reports the deployed SHA instead of `unknown`.

---

## 2. Fill in the variables

Use a **secret group** so the values are injected and never sit in git.
Everything carries over from the old host **except the rows marked CHANGE**.

| Variable | What to put | |
|---|---|---|
| `LLM_ENDPOINT_URL` | `https://<resource>.services.ai.azure.com/openai` | **CHANGE** |
| `LLM_API_KEY` | the Foundry resource key | **CHANGE** |
| `LLM_MODEL_NAME` | your deployment name, e.g. `Kimi-K3.1-Pro` | **CHANGE** |
| `FRONTEND_ORIGIN` | your Vercel URL | **CHANGE** |
| `FRONTEND_URL` | the same Vercel URL — a separate variable | **CHANGE** |
| `LLM_PROVIDER_MODE` | `openai` | same |
| `DATABASE_URL` | Supabase **pooler** URL (port 6543) | same |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | same Supabase project | same |
| `ENCRYPTION_KEY` | **the exact same value as before** | same |
| `E2B_API_KEY` / `E2B_TEMPLATE_ID` | same E2B account | same |
| `ADMIN_EMAILS` | as before | same |
| `NODE_ENV` | `production` | — |
| `REDIS_URL` | leave unset to start — see step 4 | — |

Do not set `PORT` unless you also change the exposed port; `config.ts` defaults
to 3000.

Five of these deserve a sentence.

**`LLM_ENDPOINT_URL` ends at `/openai`, no trailing slash.** The gateway appends
`/v1/chat/completions` itself, unconditionally
(`src/agents/modal-gateway.ts:365`). Getting this wrong does not give a 404 — it
gives a **200** with a body the SSE parser reads as an empty reply, and the logs
blame the model. This is the most expensive mistake in this codebase's history.

**Auth needs no code change.** Azure accepts the key as
`Authorization: Bearer <key>` on that route, which is what the gateway already
sends.

**`ENCRYPTION_KEY` must be byte-identical to the old value.** Every stored
credential in `project_env_vars` is encrypted with it. A new key does not
error — it silently fails to decrypt what is already there.

**`FRONTEND_ORIGIN` and `FRONTEND_URL` are two different variables and both are
read** (`config.ts:295-296`). The first is the CORS origin; the second is what
the integrations routes use for OAuth `client_uri` and the MCP callback.

**`ANTHROPIC_API_KEY` can stay empty.** It is in `REQUIRED_VARS`, so boot prints
a loud MISSING REQUIRED ENVIRONMENT VARIABLES banner — but it only warns, the
server starts, and with `LLM_PROVIDER_MODE=openai` the Anthropic path is never
consulted. Ignore the banner; do not buy a key for it.

---

## 3. Point the frontend at it

Northflank gives the service a URL on `code.run` with TLS already set up.

In Vercel set `VITE_API_URL` to that URL and redeploy the frontend. Then make
sure `FRONTEND_ORIGIN` and `FRONTEND_URL` hold the Vercel URL, or CORS rejects
every call.

---

## 4. Redis, once the API is stable

`src/lib/redis.ts` never throws, so the app runs without it and says so on every
boot: rate limiting fails open, sandbox IDs do not survive a restart, and build
events are not buffered for replay. Acceptable for testing, not for long.

When the API has been up for a day, **add an addon → Redis**, take its internal
connection string, put it in `REDIS_URL`, and redeploy. Watch the $20 ceiling.

---

## 5. Check it

```bash
curl https://<your-service>.code.run/health
```

Expect `{"status":"ok","commit":"...","uptimeSeconds":...}`. If you set the
`GIT_COMMIT` build argument, compare that `commit` with the SHA you deployed —
`/health` answering is not proof the new code is live.

**Probe the model before trusting it.** A wrong path returns 200, so test the
route itself rather than waiting for a build to fail:

```bash
curl -i -X POST "$LLM_ENDPOINT_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"model":"<deployment-name>","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

A correct route gives normal OpenAI-shaped JSON, or a normal OpenAI-shaped 401
if the key is wrong. **A malformed envelope with HTTP 200 means the path is
wrong**, not the key.

Then open the product and run one real build.

---

## 6. Known gap, deliberately left

`MODEL_PRICING` in `src/agents/token-tracker.ts` has no row for the new model,
so it bills at `DEFAULT_PRICING` ($1/$4) and logs a warning. For testing that is
only a wrong number in `build_outcome.costUsd` — **but `MAX_BUILD_COST_USD` is
enforced against that same number**, so the spend ceiling is wrong too. Fine
while testing; add the row before any eval whose cost figures are meant to mean
something.

---

## What was verified before any of this was written

In a clean container, 2026-11-27:

- `npm run build` → success, 1.39 MB bundle, ~200 ms.
- `npm ci --omit=dev` (what the runtime stage runs) → 183 packages, 163 MB,
  exit 0.
- `node dist/index.js` on **production dependencies only**, with no environment
  at all → boots, `/health` **200**, and **no missing module**. `REQUIRED_VARS`
  only warns; it does not throw. So the first deploy goes green before a single
  secret is filled in.
- `GIT_COMMIT=abc1234def5678` → `/health` reports `"commit":"abc1234"`.
- `npm run typecheck` → 0. `npm test` → 0.

**Not verified:** the image itself has never been built, because this container
has the Docker CLI but no daemon. The two stages were run by hand instead, which
is what the Dockerfile does. The first `docker build` is still the first.

**Also not verified:** no request has ever been made from this codebase against
the Azure Foundry endpoint. Probe it (step 5) before trusting it.
