# Moving the backend to AWS EC2

Everything here is written for one person with no budget, no domain, and a
terminal. Follow it in order. Step 0 decides whether the rest should happen at
all, so do not skip it.

**This is reversible.** `railway.toml` stays in the repo and nothing
Railway-specific has been removed. Going back is: turn the plan on, connect the
repo, paste the variables. About fifteen minutes.

---

## 0. Before spending anything — the one number that decides this

An EC2 instance bills from the moment it starts. Open:

**https://console.aws.amazon.com/billing/home#/freetier** — and also the
**Credits** tab in the left menu.

Three things to read off, and tell them to Claude:

| What | Why it decides |
|---|---|
| Credits remaining | If there are credits, EC2 is free right now. If not, it is ~$6–13/month and should wait for AWS Activate. |
| Is this account on the new **"Free plan"**? | A Free-plan account **closes itself** when its credits run out or six months pass — and that would take Bedrock down with it. You need to know this BEFORE you depend on it. |
| Bedrock spend so far | Your real burn rate, which is the number the launch plan actually turns on. |

### Set a billing alarm before you launch, not after

With credits funding this, the thing that ends the project is not a big bill —
it is credits quietly reaching zero. On the new **Free plan** an account
**closes itself** when that happens, and it takes Bedrock with it. You want to
hear about it with weeks to spare, not on the day the site stops.

Billing console → **Budgets** → **Create budget** → *Zero spend* or a monthly
cost budget → alert at **50% and 80%** → your email. Free, two minutes.

Also find, and write down, **the credits' expiry date**. On a Free-plan account
the calendar matters more than the burn rate: unused credits still expire, and
the account closes on that date whether or not money is left.

### What the runway actually is

| instance | memory | ~per month, Sydney, with 20 GB disk | months from $117 |
|---|---|---|---|
| `t4g.micro` | 1 GB | ~$8–10 | ~12 |
| **`t4g.small`** | 2 GB | ~$14–18 | **~6–8** |

Take `t4g.small`. The extra ~$6 a month buys the memory that stops `npm ci` and
the build being killed, and debugging an OOM costs more of your time than the
difference costs in money. It is also not a one-way choice: stop the instance,
change the type, start it again — a few minutes, and nothing is lost.

**Apply for AWS Activate the same day** — https://aws.amazon.com/startups/credits/
— $1,000, self-service, no investor needed, 5–10 business days. It pays for the
server *and* for Bedrock, which is the whole budget problem in one application.

---

## 1. Launch the instance

EC2 → **Launch instance**.

| Field | Value | Why |
|---|---|---|
| Name | `lampcode` | |
| AMI | **Ubuntu Server 24.04 LTS** | the scripts here are written for it |
| Architecture | **64-bit (Arm)** | `t4g` is cheaper per unit of work and every dependency in this repo is pure JS |
| Type | **t4g.small** | 2 GB. `t4g.micro` works on the swap the bootstrap adds and saves ~$6/month, but leans on it. Changeable later with stop → change type → start |
| Key pair | **Create new**, RSA, `.pem`, download it | this file is the only way in — losing it means rebuilding the box |
| Storage | **20 GiB gp3** | 8 GiB fills up on node_modules plus logs |
| Region | **ap-southeast-2 (Sydney)** | same region as the Bedrock gateway this app calls |

Network settings → **Edit**, and allow:

- **SSH (22)** — from **My IP**, not from anywhere
- **HTTP (80)** — from `0.0.0.0/0` — *required*: Let's Encrypt verifies over port 80
- **HTTPS (443)** — from `0.0.0.0/0`

Launch, then copy the **Public IPv4 address**.

---

## 2. Get in

```bash
chmod 400 ~/Downloads/lampcode.pem
ssh -i ~/Downloads/lampcode.pem ubuntu@<PUBLIC_IP>
```

## 3. Let the box read the private repo

A deploy key — read-only, this repo only, revocable. Better than putting a
personal token on a server.

```bash
ssh-keygen -t ed25519 -C "lampcode-ec2" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that line into GitHub → the Lampcode repo → **Settings → Deploy keys →
Add deploy key**. Leave "Allow write access" **unchecked**. Then:

```bash
ssh -o StrictHostKeyChecking=accept-new -T git@github.com   # expect "successfully authenticated"
git clone git@github.com:thefani1122-source/Lampcode.git
cd Lampcode
git checkout db-path     # until db-path is merged into main
```

## 4. The variables

Railway → your project → the backend service → **Variables** → copy them out.
On the box:

```bash
nano .env      # paste, then Ctrl-O, Enter, Ctrl-X
chmod 600 .env
```

Two that change, and one that is new:

```ini
PORT=3000
NODE_ENV=production
# Point at Upstash (section 7), not at Railway's internal host — that name does
# not resolve from here.
REDIS_URL=rediss://…
# This box runs ONE instance, so the Socket.IO Redis adapter has nobody to
# broadcast to and would cost one Redis PUBLISH per emit — thousands per build.
SOCKETIO_REDIS_ADAPTER=false
```

`.env.example` lists everything the app reads, with what each one is for.

## 5. Run it

```bash
sudo bash deploy/aws/bootstrap.sh
```

It installs Node and Caddy, adds swap, builds, installs the service, gets a
real certificate, and then **checks that the app actually answers** before
claiming success. If it stops, it prints the logs and what to fix.

No domain is needed: it uses `<your-ip>.sslip.io`, which resolves to your IP,
so Let's Encrypt issues a genuine certificate for it at no cost. When you own a
domain later, point it at the IP and re-run with `LAMPCODE_HOST=api.yours.com`.

## 6. Point the frontend at it

Nothing works until this is done — the frontend is still calling Railway.

1. Vercel → `vibe-coder-suite` → **Settings → Environment Variables** → set the
   backend URL to `https://<ip>.sslip.io` → **Redeploy**.
2. Back on the box, set `FRONTEND_URL` in `.env` to your Vercel URL, then
   `sudo systemctl restart lampcode`. The backend's CORS list reads it.

## 7. Redis → Upstash

Railway's Redis goes away with the Railway plan, and its internal hostname does
not resolve from EC2 anyway.

1. https://upstash.com — sign in with GitHub, create a Redis database, pick the
   region nearest Sydney.
2. Copy the `rediss://…` URL into `REDIS_URL` in `.env`.
3. Keep `SOCKETIO_REDIS_ADAPTER=false`. The free tier is 500,000 commands a
   month; the adapter alone would spend that in days, on a single-instance box
   that gains nothing from it.
4. `sudo systemctl restart lampcode`

## 8. Every deploy after this one

```bash
cd ~/Lampcode && bash deploy/aws/deploy.sh
```

Pull, build, and only then restart — a failed build leaves the running version
serving, and the script says how to roll back.

---

## When something is wrong

```bash
sudo journalctl -u lampcode -f          # the app, live
sudo journalctl -u caddy -n 50          # TLS and the proxy
curl -s localhost:3000/health           # is the app itself up
systemctl status lampcode caddy
```

- **HTTPS never comes up** → port 80 is almost always the cause. Let's Encrypt
  verifies over 80 even though the site runs on 443.
- **The frontend gets CORS errors** → `FRONTEND_URL` is unset or wrong in
  `.env`, and the backend was not restarted after setting it.
- **`npm ci` is killed** → a 1 GB `t4g.micro` without the swap the bootstrap
  adds. Re-run the bootstrap; it adds swap before building.
- **The app starts and immediately exits** → read the journal. It is nearly
  always one missing variable in `.env`.
