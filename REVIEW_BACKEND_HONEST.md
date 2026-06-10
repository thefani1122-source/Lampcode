# Lampcode Backend — Honest End-to-End Review

**Date:** 2026-06-10
**Reviewer:** Claude Code
**Scope:** Lampcode backend repo — full pipeline (prompt → AI → files → preview), API, WS, sandbox, plan mode, billing, auth
**Companion:** `vibe-coder-suite/REVIEW_FRONTEND_HONEST.md` (frontend review)

---

## Executive Summary

**The backend is the strongest part of this product — materially more complete than the frontend.**
Several things the frontend review flagged as "missing / shell" are **fully implemented on the backend**:

- **Stripe billing** — real (`billing.ts`: customers, checkout sessions, invoices, upgrade). Frontend just doesn't call it.
- **Plan mode** — fully built (`plan.ts`: interview → contract → 4-phase build with verify/fix loop, freeze contracts, brain versioning). Frontend `/plan` is a stub.
- **Credits, model fallback, E2B sandbox lifecycle, path-traversal hardening** — all real and thoughtfully done.

**So the dominant problem is NOT "build more backend." It is:**
1. **WebSocket event-contract drift** — backend emits some events the frontend never listens for (and vice-versa). This silently breaks build-failure UX, cancellation, and token streaming.
2. **A few concrete bugs** — one will throw at runtime (invalid enum write).
3. **Frontend wiring** to features the backend already exposes (Stripe, plan mode).
4. **Cleanup** — console.log spam, dead subsystems (ContextManager), dual credit accounting.

---

## ✅ What's Real & Working (Backend)

### Core Build Pipeline (`agents/`, `build.ts`)
- **Tiered model dispatch with fallback** (`dispatcher.ts`): tier 1→2→3 on RATE_LIMIT/MODEL_DOWN/UNKNOWN, 2 network retries per tier with exponential backoff. A nonexistent model ID (HTTP 400 → UNKNOWN) falls through tiers instead of crashing. Solid.
- **OpenRouter streaming gateway** (`model-gateway.ts`): SSE parsing with Zod validation, tool-call fragment accumulation, reasoning-token passthrough, Anthropic extended-thinking handling (temp=1 + `thinking` budget for non-haiku Anthropic models), structured `GatewayError` taxonomy.
- **File parser** (`file-parser.ts`): robust `\`\`\`filename:` fence extraction with heading/comment/orphan-block fallbacks, path normalization, surgical-edit (`BEGIN_EDIT`/`END_EDIT`) splicing via brace-depth counting, Sandpack vs backend file classification, server-import leak detection.
- **Smart edit modes** (`build.ts`): token-only theme edits (just the `:root` block), feature-addition mode (preserves App.tsx, adds sections), full-file edits, fullstack new builds — with CSS-protection guards and App.tsx truncation/brace-balance validation before writing.
- **Path traversal hardening** (`build.ts:783`): `resolve()` + prefix containment check — not a regex strip. Correct.
- **Fullstack retry**: detects empty required files (`api.ts`/`db.ts`/`types.ts`/`server/index.ts`) and does one focused regeneration before continuing.

### E2B Cloud Sandbox (`preview/e2b-service.ts`)
- Get-or-create-or-resume ("Lovable") pattern: live in-process reuse → Redis-backed pause/resume → fresh create. Avoids cold-start cost on follow-ups.
- Pause-on-disconnect with grace period (`build-handler.ts`), kill-on-cancel, kill-all-on-SIGTERM. Sandbox billing is actively managed — genuinely good.
- `waitForServerReady` polls the preview URL before handing back a URL.

### Plan Mode (`plan.ts`) — **fully implemented, not a stub**
- `POST /api/plan/start` → planning agent generates 5–8 interview questions (graceful default fallback).
- `POST /api/plan/interview` → contract + task breakdown (JSON, validated).
- `POST /api/plan/approve` → runs FOUNDATION→BUILD→VERIFY→DEPLOY, parallel/sequential per phase, verify→fix loop (max 3 rounds), per-phase approval gate, freeze contracts, brain versioning.
- Both `/start`/`/interview`/`/approve` and `/:id/...` path-param variants exist.

### Billing / Stripe (`billing.ts`) — **real**
- Direct Stripe REST (no SDK dep): customer create, checkout session, invoice list, plan upgrade. Dev-mode stubs when `STRIPE_SECRET_KEY` is absent.

### Auth (`auth/middleware.ts`)
- Supabase JWT Bearer verification via `supabase.auth.getUser(token)`, JWT `exp` decode for session expiry, **upsert into local `user` table so app FKs resolve**. Clean.

### Infra
- Hono + `@hono/node-server`, CORS allowlist, secure headers, rate limiting, structured pino logging, Redis-adapter Socket.IO (multi-instance ready) with event buffering + replay for late-joining clients, graceful shutdown. Production-shaped.

---

## 🔴 Critical: WebSocket Event-Contract Drift

The frontend workspace (`workspace.$projectId.tsx`) listens to **exactly these** socket events:

```
build:prompt  build:thinking  build:token  build:tool_call  build:tool_result
build:complete  build:warning  build:error  build:backend_ready
build:preview_url  build:preview_loading  build:preview_error  build:cancelled
```

The backend emits two **different** families:
- **Colon events** via `emitToRoom` (bare sessionId room): `build:thinking`, `build:file_write`, `build:tool_call`, `build:tool_result`, `build:backend_ready`, `build:complete`, `build:warning`, `build:error`, `build:preview_*`, `build:preview_log`, `file:created`.
- **Underscore events** via typed helpers (`build-handler.ts`): `build_start`, `progress`, `phase_complete`, `build_failed`, `agent_start`, `agent_progress`, `file_update`, `verify_result`, `fix_required`, `deploy_*`, `plan_phase_start`.

### Confirmed mismatches

| # | Symptom | Cause | Severity |
|---|---|---|---|
| 1 | **Failed builds hang in the UI** | Terminal failures call `server.buildFailed()` → emits `build_failed` (underscore). Frontend only listens for `build:error`. `build:error` is emitted **only** inside `stream-handler` on stream exceptions — NOT for validation failures, missing App.tsx, dispatch errors, or unsupported-runtime rejection. | **HIGH** |
| 2 | **Cancellation never reflects in UI** | Cancel path emits `build_failed` with reason "Cancelled by user". Frontend listens for `build:cancelled`, which the backend **never emits anywhere**. | **HIGH** |
| 3 | No live code/token streaming | Frontend listens for `build:token` (and `build:prompt`); backend never emits either. Code progress is sent as `build:thinking` "Writing X… (N lines)" text. Degrades gracefully but the token-stream UI is dead. | MED |
| 4 | Wasted work | `progress`, `phase_complete`, `file_update`, `agent_*` (underscore) are emitted + Redis-buffered every build but no frontend listener consumes them. | LOW |
| 5 | Per-file FileTree streaming unused | Backend emits `build:file_write` per file; frontend populates the tree from `build:complete.files` instead. Not broken, just redundant. | LOW |

**Fix direction (backend-side, lowest-risk):** make the terminal-failure path ALSO emit `build:error`, and emit `build:cancelled` on cancel. Best done by adding colon-event emits alongside the existing underscore ones (don't break the typed helpers). Then document the canonical event contract in one place (`BACKEND_CONTRACT.md`) and delete the unused underscore emits once confirmed dead.

---

## 🔴 Concrete Bugs

1. **Invalid enum write — runtime error** (`plan.ts:986`)
   `db.update(projects).set({ status: "completed" })` — `project_status` enum is `idle|building|verifying|deploying|live|failed|archived`. **"completed" is not a member** → Postgres rejects the write. Triggered when a plan contract is rejected with no modifications. Use `"idle"` or `"archived"`.

2. **Dual / unreconciled credit accounting**
   - At request time: flat `deductCredits(userId, 20)` against `userBilling.creditsUsed`.
   - At completion: `buildSessions.creditsUsed = ceil(costUsd * 1000)` — a **different unit**, stored on the session, **never added to `userBilling`**.
   - `usage` endpoint surfaces both `creditsUsed` (flat) and `totalSessionCredits` (cost-based) with no reconciliation. Pick one model.

3. **Starter-credit value disagreement (100 vs 500)**
   - `schema.userBilling.creditsLimit` default = **100**; `PLAN_CREDITS.free` = **100**; `billing.ts getOrCreateBilling` inserts with **100**.
   - `credits.ts ensureStartingCredits` / `deductCredits` insert/bump to **500** (`GREATEST(limit, 500)`), and `users.ts` defaults missing rows to **500**.
   - Net: a user's starting limit is 100 or 500 depending on which path created the row first (there's a race: `ensureStartingCredits` runs fire-and-forget in `requireAuth`, un-awaited). Decide on one number and make every path agree.

4. **ContextManager is dead in the build pipeline** (`context/manager.ts`)
   A well-built keyword-relevance file selector with caching — but `select()` is only reachable via the standalone `/api/context` route. Neither `build.ts` nor `plan.ts` feeds its output into `dispatcher.dispatch({ contextFiles })`. The dispatcher's `contextFiles` content-injection path (`prompt-builder.ts:1111`) is therefore never exercised by real builds (build.ts uses its own `existingFiles`; plan.ts passes only file *names* in a requirement string). Either wire it in or delete it.

5. **`reasoning` and `toolCalls` are dropped** (`dispatcher.ts:244-245`)
   `callModel` hardcodes `reasoning: "", toolCalls: []` in `DispatchResult` even though `stream-handler` receives them. Dead data — fine if intentional, but the fields are misleading.

6. **Next.js fullstack file-format conflict**
   `detectFramework(..., fallback="nextjs")` means a fullstack build with no framework keyword targets Next.js (`app/page.tsx`, `app/layout.tsx`). But `build.ts` requirements **hardcode** "Generate ALL of: …src/App.tsx, src/index.tsx, src/styles.css…" and `parseFilesFromContent` injects a default `src/index.tsx`/`package.json`. For a Next.js fullstack build these instructions contradict each other. Align the requirement list with the detected framework.

---

## 🟡 API Contract Cross-Check (vs frontend expectations)

| Endpoint | Backend shape | Frontend expectation | Status |
|---|---|---|---|
| `POST /api/projects` | `{ project: {id,…} }` (201) | `{id,…}` (probes `id ?? projectId`) | ⚠️ Wrapped in `project` — verify frontend reads `.project.id` |
| `GET /api/projects` | `{ projects: [...] }` | `{ projects }` or `[...]` | ✅ |
| `DELETE /api/projects/:id` | `{ success: true }`, **soft-delete (archive)** | delete | ⚠️ Archive, not delete |
| `POST /api/build/fast` | `{ sessionId, status, projectId }` | `{ sessionId,… }` | ✅ |
| `GET /api/build/:projectId/sessions` | `{ sessions: [...] }` | `{ sessions }` or `[...]` | ✅ |
| `GET /api/build/:projectId/last-session` | `{ sessionId, status }` | `{ id,… }` or session | ⚠️ Returns `sessionId`, not `id` |
| `GET /api/build/:sessionId/files` | `{ totalFiles, groups }` | `{ files: {...} }` | ⚠️ **Shape mismatch** — backend groups by dir; frontend wants a flat `files` map |
| `GET /api/users/me/billing` | `{ billing: {...} }` | `{ plan, creditsUsed,… }` | ⚠️ Wrapped in `billing` |
| `GET /api/users/me/usage` | `{ usage: {creditsUsed,creditsLimit,creditsRemaining,projectsBuilt} }` | `{ usage }` or flat | ✅ (exists in `users.ts`) |
| `GET /api/users/me/billing/usage` | richer `{ usage: {...} }` | — | ⚠️ **Duplicate** of `/me/usage`, different shape; likely unused |
| `GET/PATCH /api/users/me/settings` | `{ preferences: {theme,notifications,…} }` | `{ name, username, bio,… }` | ❌ **Mismatch** — `/settings` is *preferences*; profile name lives on `PATCH /api/users/me`. **No `username`/`bio` columns exist** → those fields can never persist. |

**Stripe is ready:** `POST /api/users/me/billing/upgrade` returns `{ checkoutUrl }`. Frontend pricing/billing "Buy"/"Manage" buttons just need to call it → Phase 3.1 drops from "Large" to "Medium (frontend wiring)".

---

## 🟡 Model Catalogue Freshness (`model-gateway.ts:10-20`)

Models are OpenRouter slugs with tier fallback. Worth verifying against OpenRouter's **live** catalog — a wrong slug silently burns a tier:

- `anthropic/claude-sonnet-4-6`, `anthropic/claude-haiku-4-5` — current generation ✅
- `anthropic/claude-opus-4-6` (planning tier-1) — **behind latest**; current top Opus is **Opus 4.8** (`claude-opus-4-8`). Planning is the highest-leverage agent (its contract propagates to all others) — upgrading tier-1 here is the single best quality lever.
- `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2.6`, `google/gemini-2.5-pro` — **verify these slugs exist on OpenRouter** (slug format and version suffixes change). Also confirm Claude slug punctuation — OpenRouter has historically used dotted versions (`claude-3.5-sonnet`), so `claude-opus-4-6` (dashes) may not resolve.

> Not a correctness bug (fallback covers a dead tier-1), but a quality/cost leak. Pin to verified slugs and refresh Opus to 4.8.

---

## 🟢 Security Review (no blockers found)

- **LLM-generated SQL is never executed** against the platform DB (`build.ts:928-933`) — schema/seed are emitted as artifacts for the *user's* deployment. Correct call; running them would be arbitrary SQL on prod.
- **Path traversal** blocked via resolved-path containment (`build.ts:783`). ✅
- **Secrets**: env-var values encrypted at rest (`project_env_vars` iv/tag columns, `env-crypto.ts`); service keys redacted in startup log. ✅
- **CORS** allowlist + credentials; **WS** ownership check (`verifySessionOwner`) on every join, 403+disconnect on mismatch. ✅
- **Rate limiting** on HTTP and WS namespaces. ✅
- ⚠️ Verify: WS auth reads the token from `handshake.auth.token` (frontend sends it there + `extraHeaders`). Confirm `wsBuildAuthMiddleware` matches.
- ⚠️ Dead schema: `session`/`account`/`verification` (Better-Auth) tables are unused at runtime (Supabase owns sessions). Harmless but confusing — drop or document.

---

## 🟡 Cleanup

- **`console.log` spam in hot paths** — `stream-handler.ts` logs every content chunk; `build.ts`, `e2b-service.ts`, `file-parser.ts`, `build-handler.ts` log per-file/per-event. Mirrors the frontend's console-spam finding. Gate behind a debug flag or move to `logger.debug`.
- **`[DEBUG] LLM output first/last chars`** (`build.ts:628-629`) ships raw model output to stdout every build.
- **Two usage endpoints**, two starter-credit values, dead ContextManager, dropped reasoning/toolCalls — consolidate.

---

## Files by Subsystem

**Pipeline:** `agents/dispatcher.ts`, `agents/model-gateway.ts`, `agents/prompt-builder.ts`, `agents/stream-handler.ts`, `agents/file-parser.ts`, `agents/token-tracker.ts`
**Build/API:** `server/routes/build.ts`, `plan.ts`, `projects.ts`, `users.ts`, `billing.ts`, `settings.ts`, `context.ts`, `integrations.ts`, `env.ts`
**WS:** `websocket/server.ts`, `websocket/handlers/build-handler.ts`, `interview-handler.ts`
**Sandbox/Deploy:** `preview/e2b-service.ts`, `deploy/pipeline.ts`, `verify/*`
**Data/Brain:** `db/schema.ts`, `context/manager.ts`, `brain/manager.ts`, `lib/freeze-contract.ts`
**Auth/Infra:** `auth/middleware.ts`, `auth/supabase-server.ts`, `build/credits.ts`, `server/index.ts`, `server/config.ts`

---

## Priority Order (backend)

1. **Fix WS terminal-failure + cancel events** (emit `build:error` / `build:cancelled`) — unblocks build-failure & cancel UX. **HIGH**
2. **Fix `status:"completed"` enum write** (`plan.ts:986`). **HIGH**
3. **Reconcile credit model** (flat-vs-cost, 100-vs-500). **MED**
4. **Fix `GET /api/build/:sessionId/files` shape** (or update frontend hydrate). **MED**
5. **Settings: drop phantom `username`/`bio`** or add columns; align profile-vs-preferences split. **MED**
6. **Decide ContextManager**: wire into dispatch or delete. **MED**
7. **Refresh model slugs** (Opus 4.8 for planning; verify all OpenRouter IDs). **MED**
8. **Frontend wiring** for already-built Stripe + Plan mode. **MED** (frontend work)
9. **Strip console.log spam / debug dumps.** **LOW**
10. **Document the canonical event + API contract** (`BACKEND_CONTRACT.md`). **LOW**
