# The image that runs the Lampcode BACKEND on a container host.
#
# This is NOT the E2B sandbox template. That is built from
# e2b-template/template.ts via Template.build(); the two e2b.Dockerfile files
# in this repo are legacy and are read by nothing. Editing them does nothing.
#
# Kept deliberately plain so it runs anywhere a container runs — Northflank,
# Koyeb, Cloud Run, Fly, a VM. After AWS, Railway and Azure each fell through
# for a different reason, not being tied to one host's build system is worth
# more than a few megabytes.

# Node 22, not 20.18.1. e2b@2.55.0 is CommonJS and does `require("chalk")`,
# while chalk@5 is ESM-only, so the process dies at boot with ERR_REQUIRE_ESM on
# any Node below 20.19.0 / 22.12.0 — the releases where require(esm) was
# unflagged. Measured 2026-11-28: 20.18.1 exits 1, 20.19.0 and 22 answer
# /health 200. An earlier version of this file pinned 20.18.1 and would have
# failed exactly the way Railway did.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Install with the lockfile first so this layer is cached until deps change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tsup leaves dependencies external (dist/index.js imports bare specifiers),
# so the runtime image needs the production node_modules — it cannot run on
# dist/ alone.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# /health reports this so a deploy can be told apart from a stale container.
# The image has no .git, so the SHA has to be passed in:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) .
# On a host that builds for you, set GIT_COMMIT as a build argument, or map
# whatever commit variable it exposes onto it. Left unset it reads "unknown",
# which costs the check but nothing else.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

# PORT is read by src/server/config.ts and defaults to 3000. Hosts that inject
# their own PORT override this; nothing needs changing for them.
EXPOSE 3000

USER node
CMD ["node", "dist/index.js"]
