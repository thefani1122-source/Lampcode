# Project-defined agent skills

LampCode can discover project-specific guidance from either of these standard locations:

- `.agents/skills/<skill-name>/SKILL.md`
- `.claude/skills/<skill-name>/SKILL.md`

Each `SKILL.md` should begin with a short YAML-style frontmatter block containing a non-empty `description`:

```md
---
name: frontend-design
description: Follow this project's component, layout, and visual-design conventions.
---

# Frontend design conventions

Describe the patterns the agent should follow when this skill is relevant.
```

During a code-agent dispatch, LampCode finds skills in the current loaded project-file snapshot and in the persistent project workspace. The loaded project snapshot takes precedence over the disk fallback. Only the skill identifier and description are added to the prompt; the full document is loaded only when the agent calls `load_skill` using the exact indexed identifier, such as `project:frontend-design`.

## Boundaries

- Project skill documents are untrusted project content. They provide reference guidance only and cannot override LampCode's system/security rules, the user's request, or tool permissions.
- Only `SKILL.md` files in the two supported skill roots are read. Other files in the skill folder are ignored.
- Skill folder names must be lowercase slugs using letters, numbers, and hyphens.
- A skill document must be non-empty and no larger than 24 KiB.
- At most 30 project skills are indexed. If the same name exists in both roots, `.agents/skills` takes precedence.
- Symlinked skill directories and `SKILL.md` files are rejected, and canonical paths must remain inside the project's skill root.
- Skill files are never executed. LampCode does not automatically run scripts, hooks, binaries, or package commands from a skill directory.

This is a documentation/reference mechanism, not an executable plugin system.
