# Engineering Reliability Improvements — Field Feedback

**Date:** 2026-11-07  
**Status:** Recommendations to audit and prioritize — not a claim that these capabilities are absent or already complete.

This note consolidates anonymized feedback from experienced software and AI-product builders, plus LampCode's existing product goals. The repository is public, so private LinkedIn conversations and identifying details are intentionally not reproduced.

## Core principle

**An agent must prove that work is done; it must not be trusted just because it says so.**

Keep both LampCode build modes first-class:
- **Build from scratch:** turn a prompt into a specified, planned, integrated and verifiable application.
- **Work in an existing codebase:** understand its architecture and conventions, make scoped changes, preserve existing behavior and verify regressions.

## Improvement backlog

### P0 — Independent, evidence-based completion
- Convert each acceptance criterion into a checkable statement.
- Separate implementation from verification. The verifier should assess the original spec and observable running application/evidence, not merely accept the builder's summary.
- Attach evidence per criterion: test result, browser interaction, screenshot/rendered output, API response, database query, build/deploy result, etc.
- Use explicit states: **PASS / FAIL / NOT RUN / BLOCKED**. Never convert “tool available” into “tool ran,” or “tool ran” into “result proven.”
- Close a task only when all required criteria pass. Otherwise return the exact failing criterion, observed result and reproducible evidence to the fixing loop.

### P0 — Runtime, browser and visual verification
- Verify the actual running app, not only generated source code or a successful build.
- Open the preview in a browser; exercise routes, forms, buttons, navigation, state changes and important user flows.
- Inspect rendered screenshots/output for visual tasks, Canvas, WebGL and 3D experiences. Code can be valid while the screen is wrong.
- Check the exact application state after interactions; save verification records that another reviewer can inspect.

### P0 — Security from the beginning
- Treat generated apps as attack surfaces. Add security checks to the normal build/verification workflow, not as a late optional review.
- Check authentication **and authorization**, tenant/data isolation, exposed secrets, unsafe API routes, injection risks, dependency vulnerabilities, insecure defaults and database access policies.
- Verify permissions and critical paths with negative tests as well as happy paths. Do not expose real credentials or production data in generated previews or test artifacts.

### P1 — Change-aware engineering playbooks
- Maintain a project playbook: architecture, conventions, scope boundaries, integrations, constraints, decisions and acceptance criteria.
- Select verification rituals based on the change: UI, API, database/schema, authentication, background jobs, integrations and deployment should trigger different checks.
- Use deterministic scripts/tools for repeatable operations instead of asking the model to improvise every time.
- Define “done” before implementation, including required checks and evidence for each task type.

### P1 — Strong contracts and controlled decisions
- Use schemas/contracts as sources of truth (for example, API specs and generated client types) so disconnected frontend/backend changes fail early.
- Keep critical business rules in one authoritative place; avoid duplicated or conflicting logic.
- Move decisions that must be exact or repeatable out of free-form model judgment and into deterministic constraints, validators or structured tools. For visual transformations, define what may move/scale/change and what must remain untouched.

### P1 — Trustworthy tests and data integrity
- Do not mock the behavior the test is supposed to prove. Use realistic integration tests and real test infrastructure where appropriate.
- Exercise concurrency, retries, duplicate events, timeouts, double submissions and failure recovery.
- Check final persisted state, not just mocked return values or a green test status.
- Add targeted mutation/fault-injection checks: deliberately break a behavior and confirm the test suite catches it.
- Enforce domain invariants at the strongest appropriate layer (often the database): transactions, unique/idempotency keys, constraints and append-only records where the domain requires them.

### P1 — Safe edits, context and long-task recovery
- Inspect existing files and dependencies before editing; prefer minimal scoped patches over broad rewrites.
- Protect user changes, review the diff before applying it, and run relevant regression checks after edits. Never overwrite uncertain or unverified work blindly.
- Preserve durable project context across long tasks: current goal, architecture, decisions, changed files, completed checks, unresolved failures and next step.
- Audit for scope/context drift at milestones. If required evidence cannot be obtained, report the blocker instead of claiming success.

## Suggested acceptance standard

A task is **verified complete** only when:
1. Its scope and acceptance criteria were agreed before implementation.
2. The change respects project contracts and security constraints.
3. Required checks actually ran in the relevant environment.
4. The running app/system was inspected for the affected workflow.
5. Each required criterion has evidence and a clear PASS result.
6. Relevant earlier criteria/regression checks still pass.
7. The final report distinguishes what was implemented, what was executed, what passed, and what remains unverified.

## Before building anything new

Audit LampCode's current code, prompts, tools and runtime against this backlog. Mark each item **Implemented + proven / Implemented but unproven / Partial / Missing / Not applicable** and link the evidence. Avoid duplicating existing capabilities; prioritize gaps demonstrated by real builds.

---
*Source: anonymized practitioner feedback and existing LampCode product requirements. Examples are design inputs, not universal prescriptions; apply database, concurrency and security controls according to the generated app's domain and risk.*
