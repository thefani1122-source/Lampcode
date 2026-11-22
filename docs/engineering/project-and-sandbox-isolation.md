# Project and sandbox isolation contract

**Status:** Current code review, 22 November 2026  
**Implementation references:** thefani1122-source/vibe-coder-suite frontend and thefani1122-source/Lampcode backend.

## The rule

A project is a durable app identity. A sandbox is a resumable runtime belonging to exactly one project. Similar names, similar prompts, elapsed time, or the fact that a sandbox is paused do not create permission to reuse another project.

- **New app:** allocate a new project UUID, then build against that ID.
- **Continue an app:** the user opens/selects that saved project, and subsequent build sessions use that exact ID.
- **Edit an open app:** follow-up prompts inside the currently selected workspace remain scoped to that app.
- **Never:** search by app title, pick the last sandbox globally, or attach a fresh project to the most recently used source tree.

## What the current frontend does

In src/components/PromptComposer.tsx in vibe-coder-suite, the dashboard/new-build flow calls POST /api/projects, receives the newly created project ID, sends that ID to POST /api/build/fast, and navigates to /workspace/{projectId}. Every submission from that new-build composer begins with a new project allocation.

The Projects list is the explicit resume path: selecting a saved project opens its workspace and loads the last build session for that selected project. Within workspace.$projectId.tsx, follow-up build requests intentionally keep using the workspace's current project ID.

**Important consequence:** typing “make a new Habit Tracker” inside an already-open Habit Tracker workspace still sends the current projectId; the server correctly treats that as a change to the selected app. To create a separate Habit Tracker, start from the dashboard's New Build/New Project flow. To edit the original, open it from Projects. This distinction is project context, not prompt similarity.

## Backend boundaries (verified in source)

| Boundary | Implementation | Isolation property |
|---|---|---|
| Project creation | src/server/routes/projects.ts | randomUUID() and authenticated userId |
| Project authorization | ownerProject(projectId, userId) | Both ID and owner must match |
| Durable source files | src/storage/project-files.ts | Private bucket prefix projectId/... |
| Sandbox metadata | src/preview/e2b-service.ts | Redis keys e2b:sandbox:projectId and e2b:framework:projectId |
| Live sandbox and prewarm | src/preview/e2b-service.ts | In-process Maps keyed by project ID |
| Build-session recovery | src/server/routes/build.ts | Filters by projectId and userId |
| Pause after disconnect | src/websocket/handlers/build-handler.ts | Resolves session to project ID, then pauses that project's sandbox |

The framework compatibility guard also prevents a saved Vite runtime from being reused as a Next.js runtime. The warmingSandboxes promise map serializes simultaneous acquisition for one project so concurrent callers do not create duplicate sandboxes for the same ID.

## Horizontal-scaling caveat

The current `warmingSandboxes` map and `pendingPauseTimers` map are process-local. They serialize concurrent creation and schedule pause grace periods inside one backend process, but they are **not** a distributed lock or shared active-client lease across multiple AWS replicas. If the backend runs more than one worker/replica, simultaneous cold acquisition for the same project could create more than one sandbox ID, and one replica's disconnect timer could pause a sandbox another replica is actively serving. Neither behavior should cross project IDs or transfer another project's files, but both can affect same-project preview reliability. Before horizontal scaling is enabled, add a Redis token-owned lock with TTL/heartbeat around create/resume/replace and a Redis-backed project activity lease for pause decisions; release/refresh must be compare-token operations, and acquisition must re-check the canonical sandbox record after obtaining the lock. Add race tests with two independent service instances.

## Pause/resume is not project reuse

When a project socket disconnects, LampCode waits 15 minutes by default before pausing its sandbox. A reconnect cancels the timer. The active sandbox lifetime is one hour by default and is refreshed on build turns. Redis sandbox metadata has a 25-day TTL; E2B snapshots have a 30-day provider lifetime.

If Redis metadata or the provider snapshot is unavailable, LampCode can create a fresh sandbox and restore files from the same project's private storage prefix. It does not restore another app or use a global “last sandbox” fallback.

This is the intended distinction:
- Resume = same project ID, same app's source, possibly same paused VM.
- Restore = same project ID and same app's persisted source, but a new VM.
- New project = a new project ID, new file prefix and new sandbox.

## Regression guard

scripts/project-isolation.test.ts runs with npm test and checks the key source invariants: UUID allocation, owner checks, per-project storage prefix, Redis key, sandbox/warm maps, framework match, and project/user-scoped build recovery.

These checks protect the backend boundary. The frontend new-project composer and saved-project selection were separately inspected in the frontend repository; this cross-repository flow is documented here because the backend test suite does not import the separate frontend repository.
