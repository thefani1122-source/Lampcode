# Personal Skills Library v1

## What is included

- Authenticated, user-owned Skills Library API at `/api/skills`.
- Import one standard `SKILL.md` document (YAML frontmatter name + description), either as a single file or from a skill folder.
- Store up to 20 Markdown reference files under `references/` (32 KiB per file, 256 KiB combined) separately from the skill body; the agent discovers paths and loads each reference only when needed.
- View and edit an installed document in place; its stable name/slug cannot change.
- Each changed document increments its revision and stores a SHA-256 content hash. Re-saving identical content is a no-op.
- Enable/disable and uninstall entries.
- Metadata-only agent discovery through `list_skills`.
- On-demand content retrieval through `load_skill` using `library:<id>`.
- Per-user ownership checks on every list/detail/import/update/enable/disable/delete path.
- Content is stored as text. Imported scripts and hooks are never executed.

## Supported scope and current limitations

- `SKILL.md` is limited to 48 KiB. Folder imports support only text Markdown under `references/` (20 files, 32 KiB each, 256 KiB combined, 336 KiB request cap).
- ZIP/folder packages, `references/`, `assets/`, GitHub import, project-level activation, team scope, multi-capability plugin manifests, and marketplace publishing are not included in this release.
- Skills are user-global and can be selected by builds across that user's projects when relevant and enabled.
- The skill name is the stable agent-facing identifier and cannot be changed in place. To rename it, install a new skill with the new name and then remove the old one.
- The runtime exposes only enabled entries. The model receives descriptions and reference paths first, then loads the skill body or a specific reference only when needed.
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

The migration creates the `user_skills` table, indexes, the JSONB reference map, and default-deny RLS. Do not assume the application will run this migration automatically. After applying it, verify that `user_skills` reports RLS enabled and has no client-facing policies.

## API

- `GET /api/skills` — list the authenticated user's metadata (no document bodies).
- `GET /api/skills/:id` — read the complete document and reference map for editing, scoped to the authenticated owner.
- `POST /api/skills` — body `{ "skillMd": "<complete SKILL.md text>", "resources": { "references/guide.md": "<Markdown text>" } }` (resources optional).
- `PUT /api/skills/:id` — replace the document body; name/slug must remain unchanged. Omitted resources preserve the current reference map.
- `PATCH /api/skills/:id` — body `{ "enabled": true | false }`.
- `DELETE /api/skills/:id` — uninstall one of the authenticated user's entries.

The frontend calls these endpoints with the existing authenticated API client. The list endpoint is intentionally metadata-only; content is retrieved only when the user edits a skill or an agent explicitly loads it. The `list_skills` tool exposes reference paths but not their contents; `load_skill` accepts an optional `resource` path for lazy retrieval.
