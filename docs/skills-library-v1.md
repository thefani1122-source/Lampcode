# Personal Skills Library v1

## What is included

- Authenticated, user-owned Skills Library API at /api/skills.
- Import one standard SKILL.md document (YAML frontmatter name + description).
- Enable/disable and uninstall entries.
- Metadata-only agent discovery through list_skills.
- On-demand content retrieval through load_skill using library:<id>.
- Per-user ownership checks on every list/load/update/delete path.
- Content is stored as text with SHA-256 provenance hash; no scripts/hooks are executed.

## Current limitations (intentional)

- Import accepts a single SKILL.md file up to 48 KiB.
- ZIP/folder packages, references/, assets/, scripts/, GitHub import, multi-capability plugin manifests, marketplace publishing and team scope are not supported by this first slice.
- Skills are user-global and can be used across the user's projects; project-specific activation is a later extension.
- There is no in-place version update yet. Remove the old entry and import the replacement.
- The runtime exposes only enabled entries. The model receives descriptions first and loads a full body only when it selects that skill.
- User skill contents are untrusted guidance. They cannot grant tool permissions or override platform rules.

## Database migration

This repository's production migrations are applied as explicit SQL by the operator. Before deploying a backend build containing this feature, apply:

    drizzle/0014_user_skills.sql

The migration creates the user_skills table and its indexes. Do not assume the application will run this migration automatically.

## API

- GET /api/skills — list the authenticated user's metadata.
- POST /api/skills — body { "skillMd": "<complete SKILL.md text>" }.
- PATCH /api/skills/:id — body { "enabled": true | false }.
- DELETE /api/skills/:id — uninstall one of the authenticated user's entries.

The frontend calls these endpoints with the existing authenticated API client.
