# Moving the backend to an Azure VM

> **BLOCKED — do not follow steps 1-3 or 6. Read `deploy/RENDER.md` instead.**
>
> Measured 2026-11-27: this subscription's compute quota is **0** and Azure
> refuses to raise it — `standardBsv2Family` is 0 in eastus, eastus2, westus2
> and centralindia, App Service B1 and F1 are 0, and the quota request itself
> returns *"not eligible for quota adjustment, consider upgrading your
> subscription"*, which Microsoft documents as expected on free and trial
> offers and also applies to Container Apps. It is an offer-level restriction,
> so no region or SKU gets around it.
>
> **Sections 4 and 5 are still the reference** — the environment table and the
> Foundry model setup. The Azure credit does work for AI Foundry, which runs on
> Cognitive Services quota, separate from compute.


Written for one person with a $200 Azure credit, no domain, and a browser.
`bootstrap.sh`, `Caddyfile` and `lampcode.service` in this directory are shared
with the EC2 path and are provider-neutral; only steps 1–2 below are Azure.

**You need nothing installed locally.** Every `az` command here runs in **Azure
Cloud Shell** (the `>_` icon in the Azure portal, or https://shell.azure.com) —
it has `az` preinstalled and already signed in as you.

---

## 0. The numbers, before you start the clock

From Azure's own retail price API, Central India, Linux, pay-as-you-go:

| Size | vCPU / RAM | Per hour | Per month |
|---|---|---|---|
| `Standard_B1ms` | 1 / 2 GB | $0.0224 | **~$16** |
| `Standard_B2s` | 2 / 4 GB | $0.0448 | **~$33** |

Add a static public IP (~$3–4) and the OS disk (~$2–5). So **B1ms ≈ $21–25 a
month**, B2s ≈ $38–42.

Two things about the $200 that decide everything else:

- It is **$200 for 30 days from the day you created the account**, not a
  balance that waits for you. Upgrading to pay-as-you-go early keeps the
  remainder, but only until that same 30-day mark. After it, this VM bills to
  your card.
- It covers **Azure services**. It does not cover E2B, which is where every
  preview sandbox runs. E2B's Hobby plan is $0 with a one-time $100 credit —
  check what is left of yours before you rely on previews working.

B1ms is the recommendation. `bootstrap.sh` adds 2 GB of swap for exactly this
reason: 2 GB of RAM is tight for `npm ci` + `tsup` on this repo, and without
swap the OOM killer takes the build with no useful message. If the build still
dies, resize once (step 7) rather than starting with B2s.

---

## 1. Create the box — Cloud Shell, four commands

```bash
az group create -n lampcode -l centralindia
```

Pick a region near your users; `centralindia`, `southeastasia` and `uaenorth`
are the cheap ones close to Pakistan. Whatever you choose, use the same one for
the Foundry resource in step 5 so model calls do not cross a continent.

```bash
az vm create \
  --resource-group lampcode \
  --name lampcode-vm \
  --image Ubuntu2204 \
  --size Standard_B1ms \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-sku Standard \
  --storage-sku StandardSSD_LRS
```

`Ubuntu2204` is an image alias Azure resolves itself. If your CLI rejects it,
run `az vm image list --output table` and use the URN from the Canonical row.
Ubuntu 22.04 is deliberate: `bootstrap.sh` takes Node 20 from NodeSource and
Caddy from Cloudsmith, both of which support it, and nothing here needs 24.04.
(The 24.04 in `e2b-template/` is the *sandbox* image and is unrelated to this
box.)

```bash
az vm open-port -g lampcode -n lampcode-vm --port 80  --priority 1001
az vm open-port -g lampcode -n lampcode-vm --port 443 --priority 1002
```

Only 80 and 443. Nothing else needs to be reachable — Redis listens on
loopback, and the backend's own port 3000 sits behind Caddy.

Write down the `publicIpAddress` that `az vm create` printed.

---

## 2. Get in

Still in Cloud Shell:

```bash
az ssh vm -g lampcode -n lampcode-vm
```

If that extension is not installed, `ssh azureuser@<publicIpAddress>` works —
`--generate-ssh-keys` put the key in Cloud Shell's `~/.ssh`, which persists.

---

## 3. Clone, and write the one file no script can write for you

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq git
git clone https://github.com/thefani1122-source/Lampcode.git lampcode
cd lampcode
cp .env.example .env
nano .env
```

Fill it in using the table in step 4, then save. **Do not run `bootstrap.sh`
before `.env` exists** — it checks for the file and stops, on purpose, because
a script that invents your keys is how a working deployment loses them.

---

## 4. What changes in `.env`, and what carries over

Everything you had on Railway or EC2 is still valid **except** the five rows
marked CHANGE. Copy the rest across unaltered.

| Variable | What to put | |
|---|---|---|
| `LLM_ENDPOINT_URL` | `https://<resource>.services.ai.azure.com/openai` | **CHANGE** |
| `LLM_API_KEY` | the Foundry resource key (step 5) | **CHANGE** |
| `LLM_MODEL_NAME` | your deployment name, e.g. `Kimi-K3.1-Pro` | **CHANGE** |
| `REDIS_URL` | `redis://127.0.0.1:6379` | **CHANGE** |
| `FRONTEND_URL` | your Vercel URL, e.g. `https://lampcode.vercel.app` | **CHANGE** |
| `FRONTEND_ORIGIN` | the same Vercel URL — a SEPARATE variable, both are read | **CHANGE** |
| `LLM_PROVIDER_MODE` | `openai` | same |
| `PORT` | `3000` | same — the Caddyfile proxies to it |
| `DATABASE_URL` | Supabase pooler URL | same |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | same Supabase project | same |
| `ENCRYPTION_KEY` | **the exact same value as before** | same |
| `E2B_API_KEY` | same E2B account | same |
| `WAITLIST_MODE` / `ADMIN_EMAILS` | as before | same |

Four of those deserve a sentence each.

**`LLM_ENDPOINT_URL` ends at `/openai`, with no trailing slash.** The gateway
appends `/v1/chat/completions` itself (`src/agents/modal-gateway.ts`), and
Azure's OpenAI-compatible route is `{endpoint}/openai/v1/chat/completions`.
This is the same rule CLAUDE.md records for `bedrock-runtime`, and getting it
wrong does not give you a 404 — it gives a 200 with a body the SSE parser reads
as an empty reply, and the logs blame the model. Both
`https://<resource>.services.ai.azure.com/openai` and
`https://<resource>.openai.azure.com/openai` work.

**No code change for auth.** Azure accepts the key as
`Authorization: Bearer <key>` on that route, which is exactly what the gateway
already sends. There is nothing to patch.

**`ENCRYPTION_KEY` must be byte-identical to the old one.** Every connected
user's stored service credentials in `project_env_vars` are encrypted with it.
A new key does not error — it silently fails to decrypt what is already there.

**`ANTHROPIC_API_KEY` can be left empty.** It is in `REQUIRED_VARS`, so boot
prints a loud MISSING REQUIRED ENVIRONMENT VARIABLES banner — but it only
warns, the server starts, and with `LLM_PROVIDER_MODE=openai` the Anthropic
path is never consulted. Ignore the banner; do not go and buy a key for it.

---

## 5. The model — Foundry, in the same region

In the portal: create a **Microsoft Foundry** (Azure AI Foundry) resource, then
deploy `Kimi-K3.1-Pro` into it.

Why that model: Microsoft lists it under **Foundry Models sold by Azure**, which
matters twice. It is billed as an Azure service, so your credit applies —
unlike Marketplace models, which the free-account terms exclude, and which is
the wall you hit on Bedrock. And its capability row says **tool calling: Yes**,
1,000,000-token input, text **and image** — this harness is tool-calling from
end to end, and `look_at_page` hands the model screenshots, so both matter.

Take the **key** and the **endpoint** from the resource's Keys and Endpoint
page, and the **deployment name** from the deployment itself — that name, not
the catalogue name, is what goes in `LLM_MODEL_NAME`.

> Known gap, deliberately left: `MODEL_PRICING` in
> `src/agents/token-tracker.ts` has no row for this model, so
> `src/agents/token-tracker.ts` bills it at `DEFAULT_PRICING` ($1/$4) and logs
> a warning. For testing that is only a wrong number in `build_outcome.costUsd`
> — but `MAX_BUILD_COST_USD` is enforced against that same number, so the
> spend ceiling is wrong too. Fine while you are testing; tell me the real
> per-million price when you want it correct.

---

## 6. Run it

```bash
sudo bash deploy/vm/bootstrap.sh
```

Once, idempotent, ~5 minutes. It installs Node 20, Caddy, **Redis** (loopback
only), 2 GB of swap, builds the repo, installs the systemd unit, and leaves the
service running behind a real certificate on `<your-ip>.sslip.io` — a free
hostname that resolves straight back to the IP, so Let's Encrypt will issue for
it with no domain to buy.

Check it:

```bash
systemctl status lampcode --no-pager
curl -s https://$(curl -s ifconfig.me).sslip.io/health
journalctl -u lampcode -n 50 --no-pager
```

`/health` answering over **https** means Caddy, the certificate and the service
are all up.

Then point the frontend at it — in Vercel's project settings:

```
VITE_BACKEND_URL = https://<your-ip>.sslip.io
```

and redeploy. (`src/lib/api.ts` and `src/lib/websocket.ts` both read
`VITE_BACKEND_URL` first.) The backend side of the same contract is
`FRONTEND_URL` in step 4 — it is what puts your Vercel origin into
`ALLOWED_ORIGINS`, and without it the browser's requests fail CORS.

---

## 7. Afterwards

```bash
# deploy a new commit
cd ~/lampcode && git pull && npm ci && npm run build && sudo systemctl restart lampcode

# stop paying while you are not testing — deallocate, do not just shut down
az vm deallocate -g lampcode -n lampcode-vm
az vm start      -g lampcode -n lampcode-vm

# if npm ci or tsup dies on 2 GB
az vm deallocate -g lampcode -n lampcode-vm
az vm resize -g lampcode -n lampcode-vm --size Standard_B2s
az vm start -g lampcode -n lampcode-vm

# delete everything, billing included
az group delete -n lampcode --yes
```

`deallocate` is the one worth remembering. A stopped-but-allocated VM still
bills for compute; a deallocated one bills only the disk and the IP. For a box
you use in bursts to test, that is most of the cost gone.

Two things this setup does **not** have, so nobody is surprised later: no
backups (the data lives in Supabase, the box is replaceable), and **one
instance only** — `pending-approvals.ts` and `pending-answers.ts` are
per-process Maps, so a second replica silently breaks every approval and every
`ask_user` no matter where Redis lives.
