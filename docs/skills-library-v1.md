# Personal Skills Library v1

## What is included

- Authenticated, user-owned Skills Library API at `/api/skills`.
- Import one standard `SKILL.md` document (YAML frontmatter name + description).
- View and edit an installed document in place; its stable name/slug cannot change.
- Each changed document increments its revision and stores a SHA-256 content hash. Re-saving identical content is a no-op.
- Enable/disable and uninstall entries.
- Metadata-only agent discovery through `list_skills`.
- On-demand content retrieval through `load_skill` using `library:<id>`.
- Per-user ownership checks on every list/detail/import/update/enable/disable/delete path.
- Content is stored as text. Imported scripts and hooks are never executed.

## Supported scope and current limitations

- Import accepts a single `SKILL.md` file up to 48 KiB.
- ZIP/folder packages, `references/`, `assets/`, GitHub import, project-level activation, team scope, multi-capability plugin manifests, and marketplace publishing are not included in this release.
- Skills are user-global and can be selected by builds across that user's projects when relevant and enabled.
- The skill name is the stable agent-facing identifier and cannot be changed in place. To rename it, install a new skill with the new name and then remove the old one.
- The runtime exposes only enabled entries. The model receives descriptions first and loads a full body only when it selects that skill.
- User skill contents are untrusted guidance. They cannot grant tool permissions or override platform rules.
- CI cannot prove the production database migration has been applied; that remains an explicit deployment operation.

## Data access boundary

`user_skills` has Row Level Security enabled and intentionally has no client-facing policies. The browser's Supabase anon key must not be able to query this table directly. All reads and writes go through the authenticated LampCode API, which scopes every operation to the authenticated `userId`.

Do not add an `anon` or `authenticated` policy, and do not query this table from browser-side Supabase clients. Any future direct access path needs a separate security review and explicit per-user policy tests.

## Database migration

This repository's production migrations are applied as explicit SQL by the operator. Before deploying a backend build containing this feature, apply:

```sql
drizzle/0014_user_skills.sql
```

The migration creates the `user_skills` table, indexes, and default-deny RLS. Do not assume the application will run this migration automatically. After applying it, verify that `user_skills` reports RLS enabled and has no client-facing policies.

## API

- `GET /api/skills` — list the authenticated user's metadata (no document bodies).
- `GET /api/skills/:id` — read the complete document for editing, scoped to the authenticated owner.
- `POST /api/skills` — body `{ "skillMd": "<complete SKILL.md text>" }`.
- `PUT /api/skills/:id` — replace the document body; name/slug must remain unchanged.
- `PATCH /api/skills/:id` — body `{ "enabled": true | false }`.
- `DELETE /api/skills/:id` — uninstall one of the authenticated user's entries.

The frontend calls these endpoints with the existing authenticated API client. The list endpoint is intentionally metadata-only; content is retrieved only when the user edits a skill or an agent explicitly loads it.
