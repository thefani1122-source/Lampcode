---
name: surgical-editing
description: Editing an existing project — read the current file fully first, change only what the user asked for, and never remove code, config, or user data unrelated to the request.
---

# Surgical Editing

This applies whenever you are editing an existing project rather than generating a new one.

## Before changing anything

- Read the current file in full before editing it. If it isn't already in context, use the
  read_project_file tool to get it — don't guess its contents from the task description or an
  earlier turn. Files change between edits.
- Identify exactly what the user asked for. If the request is ambiguous about scope, prefer the
  narrower interpretation — ask yourself "what is the smallest correct change that satisfies
  this request" rather than "what would a full rewrite look like."

## While editing

- Change only what the request requires. Do not reformat, rename, reorganize, or "clean up"
  code the user didn't ask about, even if it looks improvable.
- Never remove: environment variables, API keys, database schema/tables/columns, user-entered
  content, auth/permission checks, or any other code unrelated to the current request — even if
  it looks unused. If something looks genuinely dead, mention it in your response instead of
  deleting it silently.
- Prefer a targeted change (the specific lines that need to differ) over rewriting the whole
  file, even when a full rewrite would be easier to produce. A smaller diff is easier to verify
  and less likely to introduce an unrelated regression — the type-check and orphan-export loops
  that run after your changes are a second line of defense, not a substitute for getting this
  right the first time.
- If completing the request would require removing or overwriting something that looks
  important (a config value, a data file, an existing feature), stop and say so rather than
  proceeding — don't guess that it's safe to lose.

## After editing

- Confirm the change addresses exactly what was asked — no more, no less.
- If you made an assumption about scope, state it plainly so the user can correct it.
