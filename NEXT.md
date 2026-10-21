# What is next, and what each thing is waiting on

Updated 2026-10-21. One thread at a time: **"a request that needs a backend gets a real one."**
Nothing moves to a new thread until the list under "To finish the current thread" is empty.

Keep this file honest. If something here is done, delete it. If something turned out false, say
so rather than leaving it.

---

## A. Blocked right now, and on what

| Blocked on | What it blocks | What to do |
|---|---|---|
| **Railway incident** — "Builds are temporarily paused" (their status page, not our account) | every real-build proof below | nothing to fix. Poll `list-deployments` until a SUCCESS for a commit ≥ `6610983`. No redeploy is possible: the failed deployment has no snapshot. |
| **No Supabase connected** (`user_mcp_connections` holds only `vercel`, `github`) | the row-level half of G6/P0.4 | owner connects their Supabase in the UI; then the retry is one build |
| **`MCP_OAUTH_REDIRECT_URL` unset on Railway** | every OAuth MCP connect (503) | owner sets it to `https://<backend host>/api/integrations/mcp/oauth/callback` |
| **`db-path` is not on `main`** — the merge push was refused by this session's deploy guard | the audit-repair loop reaching production | owner merges `db-path` into `main` (one fast-forward commit, `d18f3ae`), or grants the push. Railway is paused, so nothing is lost by waiting |
| **Vercel connection is stale** (its `authType` became `oauth`; the stored static token no longer authenticates MCP) | Vercel MCP tools | owner reconnects once OAuth works. `deploy_app` is NOT affected — it reads its own token now |

---

## B. To finish the current thread — run in this order the moment builds resume

1. **Confirm the deploy is live.** A SUCCESS deployment whose commit is `6610983` or later.
   Trap 8: `/health` answering proves nothing, it is served by the old container.
2. **Real build #1 — the same expense-tracker prompt** (`scripts/launch-proof.ts`, build 1).
   Expect in the logs and the record:
   - `[build] classified … type=fullstack source=model` (or `explicit-server`)
   - `[build] db gate … intent=…` — the card actually fired
   - backend files written (`outcome.fullstack.backendFiles > 0`) and a schema file present
   - the closing message carries the honest status block, not "complete and fully functional"
   If it still classifies frontend, read `classification.source` first — it says whether a word,
   the model, or a lean decided.
3. **With a Supabase connected, repeat.** Done means: schema applied, the app writes a row, the
   row is read back after a reload, and the policies are scoped to the owner.
4. **Real build #2 — the follow-up edit.** Watch `[build] freshness …`: a repair that lands after
   a gate must now show `revalidated=[…]` rather than `revalidated=[]`.
5. **P0.5** — one build that exercises `search_code`, `delete_file`, `checkpoint`/`revert` and
   `diff_since`, each appearing in `toolCalls` having done its job.
6. **G3 adversarial** — two users, and B must not be able to read A's row.

---

## C. Not blocked — what gets done while the above waits

In order. Each one is finished and measured before the next starts.

1. **The quality of the backend we now correctly ask for.** Classification being right only
   matters if `DB_INSTRUCTIONS` then produces a *correct* backend: a schema that matches the
   tables the app queries, RLS on every table with owner-scoped policies, `dbFor(c)` used so the
   caller's identity reaches the query, and `src/lib/api.ts` in the shape the preview proxy and
   `wiring.ts` both expect. Review against the real prompt text, fix, add cases.
2. ~~**"It sees its work — now make it fix it."**~~ — **done 2026-10-21**, `src/verify/audit-repair.ts`,
   79 cases. At most five unmet requirements, a live sandbox, one attempt, tools off; kept only if
   it still compiles and does not un-prove something already proven; re-audited against the same
   criteria and the result replaces the stored audit. Recorded in `build_outcome.auditRepair`
   (attempted / fixed / remaining / cost) and in the closing status block.
   **Not yet proven on a real build** — that is section B, and it needs Railway.
3. ~~`shell` (I2)~~ and ~~scripted `browser_interact` (B6+)~~ — **both done 2026-10-21.**
   The harness tool set is complete: 27 registered, nothing absent. `diff_since` still carries
   the P0.2 defect (Codex). Neither new tool has run on a real build yet — that is section B.

---

## D. Codex — `CODEX-BRIEF.md`

1. Process: never push a red branch (`mcp-connection.test.ts` was failing and it was a real SSRF
   hole); write files as UTF-8 (an editor wrote replacement bytes and silently dropped a line).
2. An AST guard test for double-escaped regex literals — the bug class behind that SSRF hole.
3. P0.2 `diff_since` — the reason the model rewrites whole files instead of editing them.
4. The MCP OAuth **frontend** half: the popup that opens the authorization URL, plus
   `MCP_OAUTH_REDIRECT_URL`. This is the "permissions page" the owner has been asking for.
5. Hands off: `build-classifier.ts`, the classification/DB-gate block in `build.ts`,
   `supabase-mcp.ts`, and the database path.

---

## E. The standing checklist, every change, no exceptions

- `npm ci` → `npm run typecheck` → `npm test` → `npm run build`. All four, on Linux, before push.
- Never push red. Merge to `main` only after the suite passes **on main**.
- No claim without a measurement. "Probably works" goes in the "not verified" list instead.
- After any E2B template build: `cd e2b-template && npx tsx verify-template.ts` (trap 6).
- New findings go in `HISTORY.md`; `CLAUDE.md` changes only when something it states stops being
  true.
