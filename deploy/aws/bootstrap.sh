#!/usr/bin/env bash
#
# Turn a bare Ubuntu EC2 box into a Lampcode backend. Run ONCE, as the
# default `ubuntu` user, from inside the cloned repo:
#
#   sudo bash deploy/aws/bootstrap.sh
#
# Idempotent: safe to run again after a failure. It installs Node, Caddy and a
# systemd unit, and leaves the service running behind real HTTPS.
#
# It does NOT write .env — that is the one file only you can produce, and
# overwriting it from a script is how a working deployment loses its keys.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="${SUDO_USER:-ubuntu}"
NODE_MAJOR=20

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo: sudo bash deploy/aws/bootstrap.sh"
[[ -f "$REPO_DIR/package.json" ]] || die "run this from inside the cloned repo"

# ── The public hostname ──────────────────────────────────────────────────────
# The frontend is served over HTTPS, so the browser BLOCKS a plain-HTTP backend
# as mixed content — the app would look completely broken with no error anyone
# can act on. Real TLS is therefore not optional, and TLS needs a hostname.
#
# sslip.io resolves any <ip>.sslip.io straight back to that IP, so Let's
# Encrypt will issue for it. That is a real certificate on a real hostname, for
# free, with no domain to buy — which matters when the budget is zero. Set
# LAMPCODE_HOST yourself once you own a domain.
PUBLIC_IP="$(curl -fsS --max-time 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
if [[ -z "$PUBLIC_IP" ]]; then
  # IMDSv2 requires a token; the v1 call above fails silently on newer AMIs.
  TOKEN="$(curl -fsS --max-time 5 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  [[ -n "$TOKEN" ]] && PUBLIC_IP="$(curl -fsS --max-time 5 \
    -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
fi
HOST="${LAMPCODE_HOST:-${PUBLIC_IP:+${PUBLIC_IP}.sslip.io}}"
[[ -n "$HOST" ]] || die "could not read this box's public IP — set LAMPCODE_HOST=your.domain and re-run"
say "Public hostname: https://$HOST"

# ── Node ─────────────────────────────────────────────────────────────────────
# The repo needs >=20.18.1. Ubuntu's own packages are older, so take NodeSource.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  say "Installing Node ${NODE_MAJOR}"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
say "Node $(node -v)"

# ── Caddy, for TLS we do not have to think about again ───────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# ── Swap, because the cheap instances are small ──────────────────────────────
# A t4g.micro has 1 GB. `npm ci` on this repo peaks well above that and the
# OOM killer takes the build with no useful message. 2 GB of swap costs a
# little disk and removes a failure that looks like a hung machine.
if [[ ! -f /swapfile ]]; then
  say "Adding 2G swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── The .env ─────────────────────────────────────────────────────────────────
if [[ ! -f "$REPO_DIR/.env" ]]; then
  die "$REPO_DIR/.env is missing. Copy your variables from Railway into it first (see deploy/aws/README.md), then re-run."
fi
chown "$APP_USER":"$APP_USER" "$REPO_DIR/.env"
chmod 600 "$REPO_DIR/.env"

# ── Build ────────────────────────────────────────────────────────────────────
# `npm ci` installs EXACTLY what the lockfile names, and this lockfile was
# generated on x86 — so it carries @rollup/rollup-linux-x64-gnu and has never
# heard of the arm64 one. On a Graviton box the build then dies with "Cannot
# find module @rollup/rollup-linux-arm64-gnu", which reads like a missing
# dependency and is really npm's long-standing optional-dependency bug
# (npm/cli#4828). `npm install` re-resolves for the machine it is on and picks
# up the right platform binary.
#
# ci first, because a lockfile is worth honouring when it can be: it is only
# abandoned when it demonstrably cannot produce a working tree here.
say "Installing dependencies and building"
if ! sudo -u "$APP_USER" bash -lc "cd '$REPO_DIR' && npm ci --no-audit --no-fund && npm run build"; then
  # The first attempt at this guarded `npm ci` itself, which was the wrong
  # command: npm ci SUCCEEDS — "added 257 packages" — and then the build dies.
  # So the fallback has to hang off the BUILD, not the install. Removing the
  # lockfile with it is what npm's own error message asks for, and is the only
  # thing that makes npm re-resolve the platform binaries.
  say "The lockfile's tree does not build on this machine — re-resolving"
  sudo -u "$APP_USER" bash -lc "cd '$REPO_DIR' && rm -rf node_modules package-lock.json && npm install --no-audit --no-fund && npm run build"
  # Put the lockfile back. node_modules is already installed and working, and a
  # modified tracked file here would make every later `git pull` refuse.
  sudo -u "$APP_USER" bash -lc "cd '$REPO_DIR' && git checkout -- package-lock.json" || true
fi
[[ -f "$REPO_DIR/dist/index.js" ]] || die "build produced no dist/index.js"

# ── systemd ──────────────────────────────────────────────────────────────────
say "Installing the service"
sed -e "s#@REPO_DIR@#$REPO_DIR#g" -e "s#@APP_USER@#$APP_USER#g" \
  "$REPO_DIR/deploy/aws/lampcode.service" > /etc/systemd/system/lampcode.service

install -d -o "$APP_USER" -g "$APP_USER" /var/log/lampcode

# Caddy's own log directory. The Caddyfile writes an access log, and Caddy
# REFUSES TO START if it cannot open it — "permission denied" on
# /var/log/caddy/access.log, exit 1, no TLS at all. The package does not
# reliably leave this directory writable by the caddy user, and the failure
# reads as a certificate problem rather than a file-permission one, which is
# how it cost a deploy on 2026-10-23.
install -d -o caddy -g caddy /var/log/caddy

# ── Caddy ────────────────────────────────────────────────────────────────────
sed -e "s#@HOST@#$HOST#g" "$REPO_DIR/deploy/aws/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null || die "Caddyfile did not validate"

systemctl daemon-reload
systemctl enable --now lampcode
systemctl restart caddy

# ── Prove it, rather than announce it ────────────────────────────────────────
# A green "started" from systemd says the process did not exit in the first
# second. It is not evidence that the app answers, which is the only thing
# anyone cares about.
say "Waiting for the app to answer on :3000"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:3000/health" >/dev/null 2>&1; then
    say "Local health OK"
    break
  fi
  [[ $i -eq 30 ]] && { journalctl -u lampcode -n 40 --no-pager; die "the app never answered on :3000 — logs above"; }
  sleep 2
done

say "Waiting for the certificate (first issue takes ~30s)"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$HOST/health" >/dev/null 2>&1; then
    printf '\n\033[1;32m================================================\n'
    printf '  Backend is live:  https://%s\n' "$HOST"
    printf '================================================\033[0m\n\n'
    printf 'Next, and nothing works until you do it:\n'
    printf '  1. Vercel -> vibe-coder-suite -> Settings -> Environment Variables\n'
    printf '     point the backend URL at  https://%s  and redeploy.\n' "$HOST"
    printf '  2. Set FRONTEND_URL in .env to your Vercel URL, then: sudo systemctl restart lampcode\n\n'
    exit 0
  fi
  sleep 3
done

journalctl -u caddy -n 30 --no-pager
die "HTTPS never came up. Usually the security group: port 80 AND 443 must be open to 0.0.0.0/0 (80 is what Let's Encrypt uses to verify)."
