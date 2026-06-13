# Implementation Roadmap — Lampcode (vibe coder)

Captures the strategy advice (sandbox lifecycle + MCP + consistency) and maps it
to what's **already implemented** vs **still missing**, with a prioritized plan.
Companion to `.claude/skills/sandbox-lifecycle/SKILL.md` and
`PIPELINE_GAP_ANALYSIS.md`.

## Status legend: ✅ done · 🟡 partial · ❌ missing

---

## A. Sandbox lifecycle (the "preview disappears" class)

| # | Item | Status | Where |
|---|------|--------|-------|
| A1 | `setTimeout` lifetime on create AND resume AND per-turn heartbeat | ✅ | `e2b-service.ts` (SANDBOX_TIMEOUT_MS on create + tryResumeSandbox + setTimeout each turn) |
| A2 | WS-disconnect pause grace (don't pause instantly) | ✅ 15 min | `build-handler.ts` PAUSE_GRACE_MS (env SANDBOX_GRACE_MS) |
| A3 | Vite self-heal after writes (HEAD probe → pkill → restart) | ✅ | `e2b-service.ts` ensureDevServer |
| A4 | Dev-server command `timeoutMs: 0` (E2B 60s kill) | ✅ | startDevServer |
| A5 | Race-proof acquisition (promise-cache, no double sandbox) | ✅ | warmingSandboxes funnel |
| A6 | Never overwrite baked config / no runtime npm install | ✅ | BAKED_FILES filter |
| A7 | **Resume on project-page OPEN** (not just on build) | ❌ | needs WS auth/join → ensureSandbox → emit fresh preview_url; frontend sets iframe only on `ready` |
| A8 | Bump lifetime 30 min → 1 h (advice) | 🟡 optional | SANDBOX_TIMEOUT_MS |

**A7 is the remaining preview-reliability gap:** revisiting a project (no new
prompt) leaves a stale preview URL pointing at a paused/dead sandbox. Fix:
resume-on-open + frontend sets iframe src only after a fresh `ready` frame.

---

## B. Context manager / prompt system (consistency)

| # | Item | Status | Where |
|---|------|--------|-------|
| B1 | Send current file contents on edits (full snapshot) | ✅ | build.ts buildEditPrompt (`EXISTING PROJECT FILES:` block) |
| B2 | Full-file rewrites, no diffs | ✅ | prompt: "Output the complete updated files" |
| B3 | Smart file selection within token budget | ✅ | selectFollowUpFiles (lexical) |
| B4 | Persisted design tokens injected every turn | ✅ | DESIGN_TOKENS.md + relevantFiles |
| B5 | Conversation history (last 10–20 msgs) in prompt | ❌ | each build is currently history-less |
| B6 | Supabase-direct generation (no separate backend) | ✅ | FULLSTACK_INSTRUCTION rewrite |

**Consistency is mostly handled** (current files + full rewrites + design
tokens). B5 (chat history) is the only real gap and is secondary — the file
snapshot is the source of truth.

---

## C. Supabase MCP onboarding (the big new feature) ❌

User connects their OWN Supabase project; Lampcode is just the orchestrator
(Lovable model). This solves multi-tenancy, OAuth-redirect, and data-ownership.

Design:
1. **DB:** `mcp_connections (id, user_id, provider, url, access_token,
   refresh_token, status, created_at)`. Tokens **AES-256-GCM encrypted** with
   `ENCRYPTION_KEY` (already in env). RLS `user_id = auth.uid()`.
2. **OAuth:** Supabase remote MCP `https://mcp.supabase.com/mcp` (OAuth). UI
   "Connect Supabase" → popup → tokens encrypted-saved.
3. **Per build:** load user's `ready` connections → MCP client `.tools()` →
   merge with built-in tools → pass to the model → `client.close()` after.
4. **Security (non-negotiable):** decrypt only in backend memory; never to
   frontend (only `{status}`); never to the LLM context (only tools); never
   into the sandbox (public URL). Sandbox gets only sanitized results.
5. **Auth UX:** prompt mentions "login" → if no Supabase connected, chat asks
   user to connect. Generated app uses user's project URL + anon key (public,
   RLS-safe). Email/password default; Google/GitHub = user enables in their
   Supabase dashboard (show instructions), never works in the iframe preview.

---

## D. Data safety (done)

- ✅ Backend NEVER runs generated `schema.sql` against any DB (artifact only) —
  no DB-crash path.
- ✅ Refuse to inject the platform Supabase into previews (PREVIEW_SUPABASE_URL
  must differ from SUPABASE_URL) — `writePreviewEnv` guard.
- ✅ Preview uses a dedicated throwaway Supabase project; anon key only.

---

## Prioritized plan

1. **A7** resume-on-open + iframe-on-ready (+ A8 bump to 1 h) — finishes preview
   reliability so a revisited project always shows a live preview. (Backend +
   small frontend.)
2. **C** Supabase MCP onboarding — the SaaS unlock (user owns their backend).
   Start with the `mcp_connections` schema + encryption + connect flow.
3. **B5** conversation history in prompts — consistency polish.
4. Remaining `PIPELINE_GAP_ANALYSIS.md` items: G1 (validate+fix loop), G7
   (preview runtime error capture), G4 (tool-calls).
