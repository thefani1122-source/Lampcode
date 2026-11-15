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

- `SKILL.md` is limited to 48 KiB. Folder imports support only text Markdown under `references/` (20 files, 32 KiB each, 256 KiB combined, 640 KiB request cap).
- ZIP archives, binary `assets/`, project-level activation, team scope, full multi-capability plugin manifests and marketplace publishing are not included in this release. GitHub import is available through the agent tool for public repositories, or private repositories when GitHub is connected. It imports only a standard `SKILL.md` and safe Markdown references under `references/`.
- Skills are user-global and can be selected by builds across that user's projects when relevant and enabled.
- The skill name is the stable agent-facing identifier and cannot be changed in place. To rename it, install a new skill with the new name and then remove the old one.
- The runtime exposes only enabled entries. The model receives descriptions and reference paths first, then loads the skill body or a specific reference only when needed.
- User skill contents are untrusted guidance. They cannot grant tool permissions or override platform rules.
- CI cannot prove the production database migration has been applied; that remains an explicit deployment operation.

## GitHub source installation (agent-driven, no extra button)

When a user supplies a GitHub repository URL, a GitHub tree URL for a skill folder, or a raw GitHub `SKILL.md` URL and asks LampCode to download/use it, the agent can call `install_skill_from_github`. There is no separate download button or marketplace requirement.

- Public GitHub repositories can be read without connecting GitHub. Private repositories use the user's existing GitHub connection and its token.
- The installer resolves the requested branch/tag to a commit SHA and stores the immutable source revision with the installed skill.
- A repository with one root or nested `SKILL.md` is installed directly. For a repository containing multiple skills (including Claude-style plugin repositories), the agent receives the candidate folders and selects the relevant one with `skill_path`.
- Only regular non-executable `SKILL.md` and Markdown files under that skill's `references/` folder are imported. Existing file-count and byte limits still apply.
- Imported third-party text remains untrusted model guidance. The importer never executes scripts/hooks, installs commands or specialist agents, starts MCP server processes, or grants permissions.
- A plugin repository with no standard `SKILL.md` is not treated as an installable skill. Its executable/runtime capabilities require the future plugin lifecycle and isolated extension runner.

The agent immediately receives the imported skill body for the current task; the saved skill remains available to later builds through `list_skills` and `load_skill`.

## Data access boundary

`user_skills` has Row Level Security enabled and intentionally has no client-facing policies. The browser's Supabase anon key must not be able to query this table directly. All reads and writes go through the authenticated LampCode API, which scopes every operation to the authenticated `userId`.

Do not add an `anon` or `authenticated` policy, and do not query this table from browser-side Supabase clients. Any future direct access path needs a separate security review and explicit per-user policy tests.

## Database migration

This repository's production migrations are applied as explicit SQL by the operator. Before deploying a backend build containing this feature, apply:

```sql
drizzle/0014_user_skills.sql
```

The migration creates the `user_skills` table, indexes, a JSONB reference map, a separate lightweight JSONB path index, and default-deny RLS. Do not assume the application will run this migration automatically. After applying it, verify that `user_skills` reports RLS enabled and has no client-facing policies.

## API

- `GET /api/skills` — list the authenticated user's metadata (no document bodies).
- `GET /api/skills/:id` — read the complete document and reference map for editing, scoped to the authenticated owner.
- `POST /api/skills` — body `{ "skillMd": "<complete SKILL.md text>", "resources": { "references/guide.md": "<Markdown text>" } }` (resources optional).
- `PUT /api/skills/:id` — replace the document body; name/slug must remain unchanged. Omitted resources preserve the current reference map.
- `PATCH /api/skills/:id` — body `{ "enabled": true | false }`.
- `DELETE /api/skills/:id` — uninstall one of the authenticated user's entries.

The frontend calls these endpoints with the existing authenticated API client. The list endpoint is intentionally metadata-only; it returns reference paths but not reference bodies. Full documents are retrieved only when the user edits a skill or an agent explicitly loads the skill/reference. The agent index reads only the small `resource_paths` column, never the stored resource bodies. The `list_skills` tool exposes reference paths but not their contents; `load_skill` accepts an optional `resource` path for lazy retrieval.
