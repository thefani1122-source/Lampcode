import { Template } from 'e2b'

// ── Lampcode preview sandbox — v2 template definition ────────────────────────
// Minimal Node 20 base. We deliberately DO NOT COPY a scaffold or set a start
// command here: the backend (src/preview/e2b-service.ts) writes the generated
// app files, runs `npm install`, and starts Vite itself. Pre-installing the
// global tooling + common deps below just makes cold start fast — the backend's
// `npm install --prefer-offline` reuses this cache.
//
// Only FROM / RUN / WORKDIR are used (all supported by fromDockerfile in v2).
const dockerfile = `
FROM node:20-slim
RUN apt-get update && apt-get install -y git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g vite tsx typescript
WORKDIR /home/user/app
RUN npm init -y && npm install react react-dom @supabase/supabase-js && npm install -D @vitejs/plugin-react
`.trim()

export const template = Template().fromDockerfile(dockerfile)
