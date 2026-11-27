# Hosting the backend on Render's free plan

Written for one person with no money this month, a browser, and three days
already lost to cloud quotas.

**Nothing to install. No credit card. No `az`, no SSH, no Docker.**

---

## Why here, and not Azure

The $200 Azure credit is real, but the subscription cannot run a server:

| quota | where checked | limit |
|---|---|---|
| `standardBsv2Family` (VM cores) | eastus, eastus2, westus2, centralindia | **0** |
| App Service B1 | eastus | **0** |

Asking Azure to raise it returns *"not eligible for quota adjustment, consider
upgrading your subscription"*, and Microsoft documents that as expected on
free and trial offers — the same answer applies to Container Apps. It is an
offer-level restriction, so another region or a smaller SKU changes nothing.

That is not a loss. **The credit was never supposed to go on a box.** Azure AI
Foundry runs on Cognitive Services quota, which is separate and does work, so
the whole $200 now goes to the model and the evals — which is what it was
wanted for. Hosting costs $0 instead.

What free actually means here:

- 512 MB RAM, fractional CPU, one instance, **no persistent disk, no shell**.
- **Spins down after 15 idle minutes.** The next request wakes it in about a
  minute. A slow first call is a cold start, not a hang.
- 750 instance-hours a month per workspace — roughly one always-on service.

The ephemeral disk is already handled: generated project files sync to
Supabase Storage, which exists for exactly this.

---

## 1. Create the service

1. Sign up at <https://render.com> with GitHub. No card is asked for.
2. **New → Blueprint**.
3. Pick `thefani1122-source/Lampcode`, branch `main`.

Render reads `render.yaml` from the repo root and sets everything itself —
Node 20.18.1, `npm ci && npm run build`, `npm start`, health check on
`/health`. Then it lists every secret and waits for you to fill them in.
`sync: false` on each one means **no value is ever stored in git**.

---

## 2. Fill in the variables

Everything you had before is still valid **except the rows marked CHANGE**.

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
| `REDIS_URL` | leave empty for now — see below | — |

Do not set `PORT`. Render injects it and `config.ts` reads it.

Five of these deserve a sentence.

**`LLM_ENDPOINT_URL` ends at `/openai`, no trailing slash.** The gateway
appends `/v1/chat/completions` itself, unconditionally
(`src/agents/modal-gateway.ts:365`). Getting this wrong does not give a 404 —
it gives a **200** with a body the SSE parser reads as an empty reply, and the
logs blame the model. This is the single most expensive mistake in this
codebase's history; it cost days on Bedrock.

**Auth needs no code change.** Azure accepts the key as
`Authorization: Bearer <key>` on that route, which is exactly what the gateway
already sends.

**`ENCRYPTION_KEY` must be byte-identical to the old value.** Every stored
credential in `project_env_vars` is encrypted with it. A new key does not
error — it silently fails to decrypt what is already there.

**`FRONTEND_ORIGIN` and `FRONTEND_URL` are two different variables and both
are read** (`config.ts:295-296`). The first is the CORS origin; the second is
what the integrations routes use for OAuth `client_uri` and the MCP callback.
Set both.

**`ANTHROPIC_API_KEY` can stay empty.** It is in `REQUIRED_VARS`, so boot
prints a loud MISSING REQUIRED ENVIRONMENT VARIABLES banner — but it only
warns, the server starts, and with `LLM_PROVIDER_MODE=openai` the Anthropic
path is never consulted. Ignore the banner; do not buy a key for it.

### Redis

Leave `REDIS_URL` empty to start. The app does not crash without it
(`src/lib/redis.ts` never throws) — it degrades, and says so on every boot:
rate limiting fails open, sandbox IDs do not survive a restart, and build
events are not buffered for replay. For testing that is acceptable.

When you want it back, Render's free **Key Value** instance (25 MB) is in the
same dashboard; paste its internal URL into `REDIS_URL` and redeploy.

---

## 3. Point the frontend at it

Render gives the service a URL like `https://lampcode-api.onrender.com`.

In Vercel, set `VITE_API_URL` to that URL and redeploy the frontend. Then come
back and make sure `FRONTEND_ORIGIN` and `FRONTEND_URL` hold the Vercel URL,
or CORS will reject every call.

---

## 4. Check it

```bash
curl https://lampcode-api.onrender.com/health
```

Expect `{"status":"ok","commit":"...","uptimeSeconds":...}`. Compare that
`commit` against the SHA you deployed — `/health` answering is not proof the
new code is live.

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

## 5. Known gap, deliberately left

`MODEL_PRICING` in `src/agents/token-tracker.ts` has no row for the new model,
so it bills at `DEFAULT_PRICING` ($1/$4) and logs a warning. For testing that
is only a wrong number in `build_outcome.costUsd` — **but
`MAX_BUILD_COST_USD` is enforced against that same number**, so the spend
ceiling is wrong too. Fine while testing; add the row before any eval whose
cost figures are meant to mean something.

---

## Afterwards

Pushing to `main` redeploys automatically. Watch the build in Render's **Logs**
tab; `npm run build` takes about 10 seconds, the whole deploy a few minutes.

If a deploy fails on memory during `npm ci`, set a `NODE_OPTIONS` variable to
`--max-old-space-size=460`. It has not been needed — the bundle is 1.39 MB and
builds in 164 ms — but 512 MB is not much room.
