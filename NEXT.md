# What is next, and what each thing is waiting on

Updated 2026-10-23, the day the backend moved to AWS EC2 and v1 opened.

Keep this file honest. If something here is done, delete it. If something turned out false, say
so rather than leaving it. **"Built" and "proven on a real build" are different columns and are
never merged.**

---

## Where it runs now

| | |
|---|---|
| Backend | **EC2** `https://16.176.96.2.sslip.io` — Ubuntu 24.04 arm64, systemd + Caddy, branch `db-path` |
| Deploy | `cd ~/Lampcode && bash deploy/aws/deploy.sh` (see `deploy/aws/README.md`) |
| Frontend | Vercel, `www.lampcode.dev` |
| Redis | Railway public TCP proxy (`rlwy.net`) with `SOCKETIO_REDIS_ADAPTER=false` |
| Visibility | **the production Supabase, not logs.** `build_sessions.build_outcome` holds gates, classification, repairs, cost. Reading it is how everything below was verified. |

Railway is kept deliberately reachable: `railway.toml` is untouched and nothing Railway-specific
was removed, so going back is turning the plan on and pasting the variables.

---

## A. Proven on real builds — 2026-10-23

Read from `build_sessions`, not inferred.

- **Classifier decides by need, not by words.** Session df827368 → `frontend`, c777a195 →
  `fullstack`, both `source: "model"`, both with a readable reason.
- **The database gate, end to end.** Session c777a195: `schemaApply {ran:true, ok:true}`, and a
  real `tasks` table exists in the connected project — RLS on, 4 policies, the columns the prompt
  asked for. First generated table ever created, against 416 projects that produced none.
- **RLS actually blocks.** Driven against the live project: anonymous read returned `[]`,
  anonymous insert refused with "new row violates row-level security policy".
- **The preview URL survives.** `preview_url` was null on every build in history; it is written
  now and the `/files` endpoint returns it.
- **The three dead repair loops write files again.** Visible in a build's own narration: the cut
  ran, broke the type check, and put everything back.

## B. Built, NOT yet proven on a real build

Honest list. Each needs one build that exercises it.

| | why it has not fired yet |
|---|---|
| audit → repair loop | needs the audit to report something unverified; every build since has come back clean |
| schema repair (`table-never-declared`) | the model declared every table it queried |
| `service-role-key`, `caller-identity` checks | no build has violated them yet |
| `shell`, `web_search`, `fetch_reference` | **never called in any of 99 builds** |
| `checkpoint` / `revert` / `diff_since` | **never called in any of 99 builds** — this is P0.5 |
| honest status (`completed` instead of `success`) | needs a build where a gate fails |

## C. Open, and nobody has started

1. **P0.2 — `diff_since` erases real edits.** The reason the model rewrites whole files instead
   of editing them. Assigned to Codex.
2. **G3 adversarial — two users.** Prove B cannot read A's row. The single-user half is proven;
   the isolation half has never been driven.
3. **Generated-app visual quality.** No deterministic check exists for whether an app looks
   good. Nothing in this repo measures it. Named as a differentiator and genuinely untouched.
4. **Email confirmation cannot complete in a preview.** The confirmation link goes to the
   project's Site URL; the preview URL changes every build. Measured 23 Oct: sign-up could not be
   completed and `tasks` stayed at 0 rows. The system says nothing about this today.
5. **Preview fallback only polls for fullstack builds** (`workspace.$projectId.tsx` ~849), so a
   frontend-only build that misses the socket event still loses its preview permanently.
6. **MCP OAuth popup + `MCP_OAUTH_REDIRECT_URL`.** Token-paste works; the "permissions page" the
   owner asked for does not exist yet.
7. **`PREVIEW_MONGODB_URI` holds placeholders** (`<db_lampcode>`), so Mongo apps cannot connect.

## D. Owner's hands

- Rotate the Supabase **service_role** key — it appeared in a screenshot on 23 Oct.
- Enable **leaked-password protection** (Supabase → Authentication).
- Merge **`db-path` into `main`** — everything from the last three days lives only on the branch.
- AWS **billing alarm**, and write down the credits' expiry date.

---

## E. The standing checklist, every change, no exceptions

- `npm run typecheck` → `npm test` → `npm run build`. All three, on Linux, before push.
- Never push red. No claim without a measurement; "probably works" goes in section B.
- After any E2B template build: `cd e2b-template && npx tsx verify-template.ts`.
- New findings go in `HISTORY.md`; `CLAUDE.md` changes only when something it states stops being
  true.
