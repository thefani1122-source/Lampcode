#!/usr/bin/env bash
#
# Every deploy after the first. Run as the ubuntu user from the repo:
#
#   bash deploy/aws/deploy.sh
#
# Pulls, builds, and only then restarts — so a build that fails leaves the
# RUNNING version untouched instead of taking the site down to find out.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

BEFORE="$(git rev-parse --short HEAD)"
say "At $BEFORE — fetching"
git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git merge --ff-only "origin/$BRANCH" || die "not a fast-forward — someone force-pushed, or this box has local commits"
AFTER="$(git rev-parse --short HEAD)"
[[ "$BEFORE" == "$AFTER" ]] && say "Already up to date at $AFTER" || say "Now at $AFTER"

# A deploy script that deploys ITSELF has to hand over to the new copy.
# Measured 2026-10-23: the pull wrote a new deploy.sh with an arm64 build
# fallback in it, bash carried on executing the OLD text it had already read,
# the build failed exactly as before, and the fallback that was sitting on
# disk never ran. Re-exec once, guarded so the new copy does not do it again.
if [[ "$BEFORE" != "$AFTER" && "${LAMPCODE_REEXEC:-}" != "1" ]]; then
  if ! git diff --quiet "$BEFORE" "$AFTER" -- deploy/aws/deploy.sh; then
    say "This script changed in that pull — restarting with the new copy"
    LAMPCODE_REEXEC=1 exec bash "$REPO_DIR/deploy/aws/deploy.sh" "$@"
  fi
fi

# Same trap as the bootstrap: this lockfile was generated on x86, `npm ci`
# honours it exactly, and npm's optional-dependency bug (npm/cli#4828) means
# the arm64 rollup binary is never fetched. npm ci SUCCEEDS and the BUILD dies,
# so the fallback hangs off the build. Worse here than in the bootstrap: npm ci
# wipes a working node_modules first, so without this every deploy would undo
# the one that worked.
say "Installing and building"
if ! { npm ci --no-audit --no-fund && npm run build; }; then
  say "The lockfile's tree does not build on this machine — re-resolving"
  rm -rf node_modules package-lock.json
  npm install --no-audit --no-fund
  npm run build
  # Leave the tree clean so the next `git merge --ff-only` is not refused.
  git checkout -- package-lock.json || true
fi
[[ -f dist/index.js ]] || die "build produced no dist/index.js — NOT restarting, the old version is still serving"

say "Restarting"
sudo systemctl restart lampcode

# systemd reporting "active" means the process survived one second. The only
# thing worth checking is whether the app answers.
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    printf '\n\033[1;32m==> Live at %s\033[0m\n\n' "$AFTER"
    exit 0
  fi
  sleep 2
done

sudo journalctl -u lampcode -n 40 --no-pager
die "restarted but never answered on :3000 — logs above. Roll back with: git reset --hard $BEFORE && bash deploy/aws/deploy.sh"
