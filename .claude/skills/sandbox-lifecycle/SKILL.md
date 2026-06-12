---
name: sandbox-lifecycle
description: Exact step-by-step E2B sandbox setup, lifecycle, and preview pipeline for the Lampcode backend. Use whenever sandbox creation, pause/resume, file writes, Vite HMR, iframe preview, or "preview not loading" debugging comes up. Complements vibe-coder-architecture (full product); this skill is sandbox-only and opinionated about race conditions and self-heal.
---

# Sandbox Lifecycle — Exact Setup (E2B + Vite + HMR + iframe)

Single source of truth for the sandbox layer in this repo. Every rule here has
caused a real preview-blank bug when violated. Implementation lives in
`src/preview/e2b-service.ts` + `e2b-template/template.ts`.

> **This repo's stack (differs from generic guides):** Node + `npx vite` (not
> Bun), E2B **v2 SDK** template (`e2b-template/template.ts` built with
> `npx tsx build.ts` — NOT v1 `e2b.toml`/`e2b template build`, which is
> deprecated), Redis-only state (`e2b:sandbox:{projectId}`, no sandboxes DB
> table), Socket.IO for chat.

## 0. Mental model (one paragraph)

The backend never proxies preview traffic. The browser loads the preview
directly from E2B's public URL (`https://5173-{sandboxId}.e2b.app`, via
`sandbox.getHost(5173)` — never hardcode the domain). Vite's HMR WebSocket runs
inside the sandbox and talks to the browser over wss:443. The backend's only
jobs: (a) ensure a sandbox exists for `projectId`, (b) write files into it via
the E2B SDK, (c) pause/resume it.

```
Browser ──chat WS (Socket.IO)──▶ Backend ──E2B SDK──▶ Sandbox (Vite :5173)
   │                                                       │
   └────────iframe (HTTPS) + HMR (wss:443)─────────────────┘
```

**Two WebSockets. They never interact.** LLM code does NOT travel over any
WebSocket into the sandbox — it goes backend → `sandbox.files.write()`.

## 1. Custom template (`e2b-template/`, v2 SDK)

Baked into `lampcode-vite`: node_modules (react, react-dom,
@supabase/supabase-js, vite, plugin-react, typescript) + the full baseline
scaffold (package.json, vite.config.ts, tsconfig, index.html, src stub).
Cold start ≈ 2s, zero install per prompt.

The baked `vite.config.ts` — every line is load-bearing:

```ts
server: {
  host: true,                                  // bind all ifaces — E2B port-forward needs it
  port: 5173,
  strictPort: true,                            // crash loudly, never drift to 5174
  allowedHosts: true,                          // Vite 5+ blocks the dynamic *.e2b.app host otherwise
  hmr: { clientPort: 443, protocol: 'wss' },   // browser is on HTTPS; without this HMR dials ws://localhost
  watch: { usePolling: true, interval: 300 },  // files.write() doesn't fire reliable FS events
}
```

Failure modes if any line is missing: no `host` → port unreachable; no
`allowedHosts` → "Blocked request"; no `hmr.clientPort` → edits never reflect;
no `usePolling` → preview goes stale after writes.

**No `start_cmd` / CMD in the template — deliberate deviation.** The backend
must write `.env` (preview Supabase creds) BEFORE Vite boots, because Vite only
reads `VITE_*` at startup. A template start_cmd would boot Vite before the env
exists. So the backend owns the start: write env → `npx vite` (background,
`timeoutMs: 0`) → poll ready.

Rebuild (only when template.ts changes): `cd e2b-template && npx tsx build.ts`
(needs `.env` with `E2B_API_KEY`). Backend env: `E2B_TEMPLATE_ID=lampcode-vite`.

## 2. Backend rules (all in `src/preview/e2b-service.ts`)

### 2.1 Timeouts — the three killers (all hit us in production)
1. **Command timeout:** `commands.run()` default is **60s and applies to
   background commands** — it killed Vite a minute after boot. Dev server runs
   with `timeoutMs: 0`.
2. **Create lifetime:** sandbox default lifetime is **5 minutes**. We create
   with `timeoutMs: SANDBOX_TIMEOUT_MS` (30 min).
3. **Resume lifetime:** `Sandbox.connect()` ALSO defaults to 5 minutes — pass
   `timeoutMs` there too, or every resumed sandbox dies 5 min later.

Heartbeat: every build turn / follow-up write calls
`sandbox.setTimeout(SANDBOX_TIMEOUT_MS)` so active sessions never expire.

### 2.2 Race condition — promise-cache
`prewarmSandbox()` fires at build start (parallel with generation). ALL
acquisition funnels through the `warmingSandboxes: Map<projectId, Promise>` —
concurrent callers (prewarm vs completion, double builds) share ONE in-flight
acquire, so a second sandbox can never be created/leaked for the same project.

### 2.3 File writes
- Only the LLM's app files are written. **Blocked:** `package.json`, lockfiles,
  `vite.config.*`, `tsconfig*`, `index.html`, `.env*` (BAKED_FILES — template
  owns them; overwriting them is what used to crash Vite), plus any path with
  `..` or a leading `/` (traversal).
- **No runtime `npm install`, ever.** Deps are baked. Runtime installs
  disrupted the running dev server ("no service on port 5173").
- Writes happen once per completed build (full parse), never mid-stream — so
  partial-file syntax errors can't hit the sandbox.

### 2.4 Self-heal (`ensureDevServer`)
Before every URL handoff: HEAD-probe the preview URL (3s). If dead →
`pkill -f vite || true` → restart Vite (background, timeoutMs 0) → poll up to
30s → only then return the URL. Never hand out an unverified URL.

### 2.5 Env injection
`writePreviewEnv()` writes `.env` (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
from `PREVIEW_SUPABASE_URL`/`PREVIEW_SUPABASE_ANON_KEY` config) BEFORE Vite
starts. Anon key only — never the service key.

## 3. Lifecycle state machine

```
idle ──first prompt──▶ creating(prewarm, ~2s) ──▶ running
paused ──new prompt──▶ resuming(connect, ~150ms) ─▶ running
running ──WS close + 5min grace──▶ paused (snapshot, ≈free)
running ──every turn──▶ setTimeout refresh (heartbeat)
any ──project delete──▶ killed (sandbox + Redis record)
```

- One project = one sandbox. Redis `e2b:sandbox:{projectId}` → sandboxId
  (TTL 25 days; E2B snapshots expire at 30).
- Grace rule: never pause immediately on disconnect — users refresh tabs.
  `schedulePause` waits PAUSE_GRACE_MS; reconnect cancels it.
- Backstop: if the process dies and timers are lost, the sandbox's own
  lifetime timeout (30 min) prevents leaks.

## 4. What lives where

| Thing | Lives in |
|---|---|
| Frontend code (src/**) | Sandbox FS (Vite serves it) |
| package.json / vite.config / node_modules | Baked in template — LLM never touches |
| Database schema + data | Supabase Cloud (NOT the sandbox) |
| schema.sql | Artifact in sandbox FS; run manually in Supabase SQL editor |
| projectId → sandboxId | Redis |
| LLM token stream | Chat WS (browser↔backend) — never the sandbox |
| HMR updates | Sandbox Vite WS (browser↔sandbox) — never the backend |

**Supabase-direct rule:** generated apps call `supabase.from(...)` straight
from the frontend (RLS-secured). No `src/server/` is generated; the sandbox
runs a pure frontend app. That's why the preview works end to end.

## 5. "Preview not loading" — debug order

1. Sandbox running? Redis `GET e2b:sandbox:{projectId}`; Railway logs `[E2B]`.
2. Vite up? `curl -I https://5173-{id}.e2b.app` → expect 200/304. Timeout →
   self-heal should fire; check "Dev server not responding" log line.
3. Died at exactly 5 min? → a `connect/create` path is missing `timeoutMs`.
4. Died at exactly 60s? → a background command is missing `timeoutMs: 0`.
5. "Blocked request"? → baked vite.config got overwritten — check BAKED_FILES.
6. Edits not reflecting? → DevTools Network: HMR must dial `wss://5173-…:443`,
   not `ws://localhost`; and usePolling must be in the baked config.
7. Blank page, app loaded? → browser console; usually `createClient(undefined)`
   = PREVIEW_SUPABASE_* not set in Railway.
8. Two sandboxes for one project? → acquisition bypassed `warmingSandboxes`.

## 6. Env vars (backend)

```
E2B_API_KEY=
E2B_TEMPLATE_ID=lampcode-vite
PREVIEW_SUPABASE_URL=          # preview Supabase project URL
PREVIEW_SUPABASE_ANON_KEY=     # anon key only (RLS-protected, safe for preview)
REDIS_URL=
```

## 7. Do / Don't

DO: funnel all acquisition through the promise-cache · pass lifetime
`timeoutMs` on EVERY create AND connect · refresh lifetime every turn ·
probe-then-hand-out URLs (self-heal) · write env before Vite boots.

DON'T: proxy preview through the backend · let the LLM touch
package.json/vite.config · run `npm install` at runtime · pause instantly on
disconnect · run background commands without `timeoutMs: 0` · trust E2B's 5-min
defaults · hardcode `.e2b.dev`/`.e2b.app` hosts (use `getHost()`).
