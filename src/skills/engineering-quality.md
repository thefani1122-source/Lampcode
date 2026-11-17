---
name: engineering-quality
description: Production engineering practices for code generation, bug fixes and refactors — complete implementations, minimal scope, maintainable structure, real tests and honest verification.
---

# Engineering Quality

Use this skill for meaningful code changes, bug fixes, refactors and new application work.

## Preserve the user's intent

- Treat the original user request as the source of truth. Implement the requested outcome, not a larger product you imagine would be better.
- Do not invent features, screens, roles, fields, dependencies, workflows or migrations. Offer useful additions as suggestions instead of silently implementing them.
- Preserve existing behavior, public contracts, architecture, data and design decisions unless the user explicitly asks to change them.
- When instructions appear to conflict, distinguish actual runtime constraints from generic preferences. Do not treat examples, inferred plans or historical notes as user requirements.

## Understand before editing

- Inspect the current project structure and the full relevant files before changing them.
- Trace callers, consumers, route wiring, schemas and related tests before changing a shared function or contract.
- For a bug, identify the failing path and root cause before editing. Do not patch only the visible symptom.
- Search existing project history/engineering decisions where relevant, but verify historical claims against current source.
- Prefer the smallest coherent change that fixes the root cause. Avoid unrelated cleanup or broad rewrites.

## Write complete, maintainable code

- Never leave half a function, empty handler, placeholder return, fake integration, TODO-as-implementation, or a button that does not perform its labelled action.
- Implement the whole behavior path: input, validation, state/data changes, persistence or API call, errors, and visible outcome.
- Keep responsibilities cohesive. Separate screens, domain logic, data access and shared types where that improves comprehension; do not split files mechanically just to meet a file count.
- Use the repository's actual framework, package versions, patterns and error-handling conventions. Do not invent installed packages or runtime capabilities.
- Keep types strict. Prefer unknown with narrowing over any; validate external data at boundaries.
- Avoid duplicate implementations. When replacing behavior, trace references and retire the old path only when it is confirmed obsolete.
- Avoid unnecessary abstractions, premature generalisation and excessive one-line helpers. Code should be easy for the next engineer to read and change.

## Edit the right way

- Use targeted edits for small changes to existing files. Use whole-file writes for new files or when a deliberate rewrite is genuinely clearer.
- A whole-file write replaces the entire file: never pass a fragment, half-function or partial component to it.
- Read the current contents before constructing an exact replacement. An edit must have an unambiguous target; if the text does not match exactly, re-read rather than guessing.
- Do not rewrite unrelated files to satisfy a tool or generated checklist. Do not delete unrelated configuration, security logic or user data.
- Keep package changes minimal; explain why a new dependency is required.

## Verify the result

- Choose checks based on the changed behavior: typecheck, relevant tests, runtime/browser checks, integration checks and security tests.
- Test edge cases and failure paths for non-trivial logic. A test should verify behavior, not merely restate implementation.
- Re-run checks after later edits that could invalidate earlier evidence. Never present stale results as current.
- Distinguish passed, failed, unavailable and not-run checks. A successful build does not prove the requested feature works.
- If a required service or test account is unavailable, implement what can be verified and state precisely what remains unverified.
