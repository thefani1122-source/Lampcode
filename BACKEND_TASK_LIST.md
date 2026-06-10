# Lampcode Backend — Task List & System Documentation

**Date:** 2026-06-10
**Companion docs:** `REVIEW_BACKEND_HONEST.md` (this repo), `vibe-coder-suite/TASK_LIST.md` + `REVIEW_FRONTEND_HONEST.md` (frontend)

This is the **backend** counterpart to the frontend task list. It documents how the
prompt system works, what frameworks/databases are supported, how the E2B sandbox +
Vite HMR work (and why the preview was broken), and a complete what-works / what-breaks /
remaining-tasks summary.

---

## 1. How the Prompt System Works (`agents/prompt-builder.ts`)

The prompt sent to the model is assembled in `PromptBuilder.build()` from three parts:

```
systemPrompt  = base[agentType] + frameworkRules + fullstackInstr + dbInstr + authInstr + editInstr + jsonInstr
userMessage   = contextBlock (brain files / selected files)  +  taskBlock (task + requirements + project context)
```

Token budget: **20,000 input tokens** (`MAX_INPUT_TOKENS`, ~4 chars/token). The user
message is truncated to the last complete line if it would exceed the budget.

### 1a. Per-agent system prompts (`SYSTEM_PROMPTS`)
One base persona per agent type:
- **planning** — "BuildForge Architect"; outputs a full `CONTRACT.md` (app overview, tech stack, DB schema + RLS, API routes, pages, auth flow, env vars, agent task breakdown). JSON output.
- **frontend** — design rules (purpose-matched colors, no dead UI, complete mock data), strict file-completeness rules (never truncate, close every JSX tag, no phantom imports), a **CSS budget** (<100 lines, ≤15 `:root` vars), and a "plan in 2-3 sentences before code" rule.
- **backend** — Hono.js (preferred), Zod validation, consistent JSON, no internal error leakage.
- **db** — Supabase Postgres CREATE TABLE SQL, snake_case, FKs, `created_at TIMESTAMPTZ`, indexes + TS interfaces.
- **security** — OWASP-style findings as JSON (severity/location/remediation).
- **connection / fix / deploy / monitor** — integration wiring, bug-fix diffs, CI/CD config, observability.

### 1b. Mode detection & instruction stacking
- **Framework** (`detectFramework`) — keyword match on the prompt; fullstack default **Next.js**, frontend-only default **React**.
- **Database** (`detectDatabase`) — `mongo` → MongoDB, else **Supabase**.
- **Fullstack mode** — triggered when the task description is prefixed `FULLSTACK BUILD:` / `FULLSTACK AUTH BUILD:` (set by `build.ts` `needsBackend()`/`needsAuth()`). Appends `FULLSTACK_INSTRUCTION` (file contract: db/types.ts, server/index.ts, routes/api.ts, lib/db.ts, lib/api.ts, env files, README) + DB-specific rules + (if auth) the full Supabase auth scaffold (`useAuth`, `AuthProvider`, `Login`, OAuth buttons).
- **Edit modes** — prefix-driven:
  - `EXISTING PROJECT FILES:` → edit mode (preserve design, surgical `// BEGIN_EDIT / // END_EDIT` for <50% changes, full file otherwise).
  - Token-only theme edits → only the `:root { }` block is sent/returned (`build.ts buildTokenEditPrompt`).
  - Feature-addition → sends App.tsx + a structural summary, instructs "ADD only, preserve everything" (`buildAdditionEditPrompt`).
- **Prompt expansion** (`expandUserPrompt`) — short prompts matching app-type patterns (todo, dashboard, kanban, landing, timer, chat) get completeness checklists appended so the model builds the full app, not a skeleton.

### 1c. Context block (brain files)
`relevantFiles(agentType)` picks which brain docs to inject: `CONTRACT.md`, `DB_SCHEMA.md`,
`API_CONTRACTS.md`, `CURRENT_STATE.md`, plus `DESIGN_TOKENS.md` / `MEMORY_RULES.md` for the
frontend agent. These are read from `workspace/{projectId}/` (project-specific, persisted
across builds) — this is how **design tokens and memory rules survive between prompts**.

---

## 2. Supported Frameworks & Databases

### Frameworks (`FRAMEWORK_RULES`, frontend agent only)
| Framework | Trigger | Default for | Entry files |
|---|---|---|---|
| **React + TS** | `react`/`vite`/`python`/`fastapi`/`django` | frontend-only builds | `src/App.tsx`, `src/index.tsx`, `src/styles.css` |
| **Next.js 14** | `next`/`nextjs` | fullstack (no keyword) | `app/page.tsx`, `app/layout.tsx`, `app/globals.css` |
| **Vue 3** | `vue` | — | `src/App.vue`, `src/main.ts`, `index.html` |
| **Svelte 4** | `svelte` | — | `src/App.svelte`, `src/main.ts` |
| **SolidJS** | `solid`/`solidjs` | — | `src/App.tsx`, `src/index.tsx` |
| **Preact** | `preact` | — | `src/App.tsx`, `src/index.tsx` |

Each framework ships its own sandbox restrictions (no fetch except `src/lib/api.ts` in
fullstack, no localStorage, inline SVG icons, framework-correct reactivity rules). Python/
FastAPI/Django prompts pair a **React+Vite frontend** with a non-Node backend that runs only
in the E2B sandbox (not Sandpack).

### Databases (`DB_INSTRUCTIONS`)
| DB | Trigger | Notes |
|---|---|---|
| **Supabase (Postgres)** | default | `@supabase/supabase-js`, `src/db/schema.sql` for the dashboard, `.env` + `.env.example`, README setup steps. **Not** drizzle/TCP drivers in generated apps. |
| **MongoDB Atlas** | `mongo`/`mongodb` | Mongoose, `{ timestamps: true }`, `.lean()`, Atlas connection-string README. |

> Note: the generated app's DB layer is Supabase/Mongo. The **platform's own** DB (Lampcode
> backend) uses Drizzle + Postgres — separate concern.

---

## 3. E2B Sandbox + Vite HMR — Deep Dive (and why preview was broken)

### How it's supposed to work (`preview/e2b-service.ts`)
Preview only runs for **fullstack builds** (Sandpack handles frontend-only in-browser).
The "Lovable" get-or-create pattern:
1. **Live in-process** sandbox for the project? → just write files, return URL (Vite HMR refreshes).
2. **Paused** (Redis has `e2b:sandbox:{projectId}`)? → `Sandbox.connect()` resumes it → write files → return URL.
3. **Neither** → `Sandbox.create(TEMPLATE_ID)` → write files → `npm install --prefer-offline` → `npx vite --host 0.0.0.0 --port 5173` → poll `waitForServerReady` → return URL.

**Follow-up builds** (`writeFilesToSandbox`) push files straight into the running sandbox; **Vite's HMR** detects the file changes and refreshes the preview with no reinstall/restart. Sandboxes are paused on disconnect (2-min grace) and killed on cancel / SIGTERM to control E2B billing.

### The custom template (`e2b-template/`)
- `e2b.toml` → `id = "lampcode-vite"` (set as `E2B_TEMPLATE_ID=lampcode-vite` on Railway).
- `e2b.Dockerfile` → `node:20-slim`, pre-installs react/react-dom/hono/zod/supabase + vite, bakes a `vite.config.ts` with `allowedHosts: true`, `CMD ["npx","vite","--host","0.0.0.0","--port","5173"]`.
- Pre-baking deps + scaffold = fast cold-start.

### 🔴 Why the preview wasn't showing (ROOT CAUSE — verified via git history)
Commit `03779c5` ("add custom E2B template") introduced **two regressions**:

1. **Preview URL broken.** `previewUrlFor` was changed from
   `https://${sandbox.getHost(DEV_SERVER_PORT)}` (correct SDK API) to a hardcoded
   `https://5173-${sandbox.sandboxId}.e2b.dev`. The SDK's `getHost(port)` returns the
   correct public host (domain + region) for the deployment; the hardcoded `.e2b.dev`
   string does not resolve. Because the **backend also polls this URL** (`waitForServerReady`),
   a wrong URL → poll times out → `build:preview_error` → **no preview ever appears.**
   → **FIXED** (this commit): reverted to `sandbox.getHost(DEV_SERVER_PORT)`.

2. **allowedHosts patch removed.** The same commit deleted `patchViteAllowedHosts`, betting
   the baked template config is enough. But the **LLM writes its own `vite.config.ts`** into
   the sandbox, overwriting the template's. Vite 5+ rejects requests from unknown hosts, so
   if the generated config lacks `allowedHosts`, the E2B host is blocked → blank iframe.
   Only the **React** template config had `allowedHosts: true`; Vue/Svelte/Solid/Preact did not.
   → **PARTIALLY FIXED** (this commit): added `allowedHosts: true` to all framework vite
   configs in `prompt-builder.ts`. (A framework-aware runtime re-patch is still worth adding
   as a belt-and-suspenders — see Task B2.)

### ⚠️ Still to verify (needs E2B testing — do NOT assume)
- **Double Vite process?** The template Dockerfile `CMD` auto-starts Vite on boot, AND
  `startDevServer()` runs `npx vite ...` again → possible port-5173 conflict (`EADDRINUSE`).
  If the second start fails silently (`background:true` swallows it), the preview may serve
  the template's baseline "Ready" page, not the user's app. Verify against a live sandbox.
- **Two Dockerfiles disagree.** Root `e2b.Dockerfile` (`e2bdev/code-interpreter:latest`,
  global vite, no CMD) vs `e2b-template/e2b.Dockerfile` (`node:20-slim`, CMD vite). Only the
  one beside `e2b.toml` is the real template; the root one looks legacy. Reconcile/delete.
- **Template deps vs generated imports.** Template pre-installs react/react-dom/hono/zod/
  supabase. If a generated app imports `react-router-dom`/`lucide-react` (root Dockerfile had
  them, template doesn't), `npm install` must hit the network → slower / can fail offline.

---

## 4. Complete Summary

### ✅ What works (backend)
- Tiered model dispatch + fallback + retries (`dispatcher.ts`)
- OpenRouter SSE streaming, tool-call accumulation, error taxonomy (`model-gateway.ts`)
- File parsing, surgical edits, smart edit modes, path-traversal guard (`file-parser.ts`, `build.ts`)
- Fullstack detection + missing-file retry
- E2B sandbox lifecycle: create/resume/pause/kill, billing control (`e2b-service.ts`)
- **Plan mode fully built** (`plan.ts`): interview → contract → 4-phase build + verify/fix loop
- **Stripe billing built** (`billing.ts`): checkout, invoices, upgrade
- Supabase JWT auth + user upsert, credits, audit log, env-var encryption
- Hono + Socket.IO (Redis adapter, event buffering/replay), rate limiting, graceful shutdown

### ❌ / ⚠️ What breaks or is broken
| Issue | Where | Status |
|---|---|---|
| **Preview URL wrong** (`e2b.dev` hardcode) | `e2b-service.ts:174` | ✅ FIXED this commit (getHost) |
| **allowedHosts missing on non-React configs** | `prompt-builder.ts` | ✅ FIXED this commit |
| **Failed/cancelled builds hang UI** (`build_failed`/no `build:cancelled`) | WS event contract | ❌ open (HIGH) |
| **Invalid enum write** `status:"completed"` | `plan.ts:986` | ❌ open (HIGH) |
| Dual/unreconciled credit accounting | `build.ts` + `credits.ts` | ❌ open |
| Starter credits 100 vs 500 disagreement | `schema`/`billing.ts` vs `credits.ts`/`users.ts` | ❌ open |
| `GET /build/:sessionId/files` shape mismatch | `build.ts` vs frontend hydrate | ❌ open |
| Settings: phantom `username`/`bio` (no columns) | `settings.ts`/`users.ts` | ❌ open |
| ContextManager built but unused in build pipeline | `context/manager.ts` | ❌ open |
| Double Vite / Dockerfile mismatch | E2B template | ⚠️ verify |
| Stale model slug `claude-opus-4-6` (planning) | `model-gateway.ts` | ❌ open |
| console.log spam in hot paths | multiple | ❌ open |

---

## 5. Backend Task List

### PHASE B0 — Preview fixes ✅ (this commit)
- [x] Revert `previewUrlFor` to `sandbox.getHost(DEV_SERVER_PORT)`
- [x] Add `allowedHosts: true` to Vue/Svelte/Solid/Preact vite configs

### PHASE B1 — Critical (do next)
- [ ] **B1.1 WS terminal events** — emit `build:error` on every terminal failure (not just stream exceptions) and `build:cancelled` on cancel. Currently failures emit `build_failed` (underscore) which the frontend ignores → builds hang. *(pairs with frontend Phase 1.2)*
- [ ] **B1.2 Invalid enum** — `plan.ts:986` writes `projects.status = "completed"` (not a `project_status` value) → Postgres rejects. Use `"idle"`/`"archived"`.
- [ ] **B1.3 Verify preview end-to-end** — with a real E2B key + `E2B_TEMPLATE_ID=lampcode-vite`, run a fullstack build and confirm the iframe loads. Check for the double-Vite / port conflict.

### PHASE B2 — Sandbox hardening
- [ ] **B2.1** Framework-aware runtime allowedHosts safety patch (don't overwrite the framework plugin — only ensure `allowedHosts` is present), OR confirm the prompt-config fix is sufficient in practice.
- [ ] **B2.2** Reconcile the two Dockerfiles; delete the legacy root one or document which is canonical.
- [ ] **B2.3** Decide Vite startup ownership: template `CMD` vs `startDevServer()` — pick one to avoid port conflicts.
- [ ] **B2.4** Align template pre-installed deps with what generated apps commonly import (router, icons) to keep installs offline-fast.

### PHASE B3 — Contract & data correctness
- [ ] **B3.1** Reconcile credit accounting (flat-deduct vs cost-based session credits) into one model.
- [ ] **B3.2** Make starter-credit value (100 vs 500) consistent across schema/`billing.ts`/`credits.ts`/`users.ts`.
- [ ] **B3.3** Fix `GET /api/build/:sessionId/files` to return a flat `{ files: {...} }` map (or update the frontend hydrate).
- [ ] **B3.4** Settings: drop phantom `username`/`bio` or add columns; clarify profile (`PATCH /me`) vs preferences (`/me/settings`).
- [ ] **B3.5** Remove the duplicate usage endpoint (`/me/billing/usage` vs `/me/usage`).
- [ ] **B3.6** Write `BACKEND_CONTRACT.md` — canonical event + endpoint shapes; then remove unused underscore WS emits / frontend defensive probing.

### PHASE B4 — Cleanup & quality
- [ ] **B4.1** Wire ContextManager into the build/plan dispatch (`contextFiles`) or delete it.
- [ ] **B4.2** Stop dropping `reasoning`/`toolCalls` in `dispatcher.ts` (or remove the fields).
- [ ] **B4.3** Refresh model slugs — upgrade planning tier-1 to **Opus 4.8**; verify all OpenRouter IDs resolve.
- [ ] **B4.4** Strip `console.log` spam / `[DEBUG]` raw-output dumps from hot paths → `logger.debug`.
- [ ] **B4.5** Align fullstack Next.js file-format instructions (App.tsx vs app/page.tsx contradiction).
- [ ] **B4.6** Drop or document unused Better-Auth tables (`session`/`account`/`verification`).

### PHASE B5 — Frontend wiring (cross-repo, backend is ready)
- [ ] **B5.1** Stripe: frontend calls existing `POST /api/users/me/billing/upgrade`; add a webhook handler to flip `userBilling.plan` on `checkout.session.completed` (verify `webhooks.ts`).
- [ ] **B5.2** Plan mode: frontend wires to existing `/api/plan/*` flow + `/interview` namespace events.
