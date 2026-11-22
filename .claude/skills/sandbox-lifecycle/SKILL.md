---
name: sandbox-lifecycle
description: Project-scoped E2B lifecycle, Ubuntu Vite/Next.js candidates, source recovery, dependencies and preview health.
---

# Sandbox lifecycle — project isolation is the invariant

Implementation: `src/preview/e2b-service.ts`, `src/storage/project-files.ts`, `src/server/routes/projects.ts`, `src/server/routes/build.ts`, and `src/websocket/handlers/build-handler.ts`.

## 1. Identity: project, build session and sandbox are different things

- `projectId` is the durable app identity. One project owns its file-storage prefix, Redis sandbox key, in-process sandbox reference and in-flight warm lock.
- `sessionId` identifies one build conversation/turn. Several build sessions can belong to one project; they intentionally edit the same app and may reuse its sandbox.
- A fresh project is created by `POST /api/projects`, which allocates a new UUID for the authenticated user. The dashboard's new-build composer creates that project before calling `POST /api/build/fast`.
- Opening an existing project from the Projects list is the explicit resume path: the frontend uses that selected project's ID and loads its last session.
- Do not infer project identity from the app name, prompt similarity, latest session, last-used sandbox or user ID. Never attach a newly created project to another project's sandbox/files.

**Important UX boundary:** prompts sent inside an already-open workspace are scoped to that selected project. They are edits to that app, even if the product name is repeated. To start a genuinely new app, use the dashboard's New Build/New Project flow so it allocates a new `projectId`. To continue an old app, select that project in the Projects list. Never silently switch project IDs based on a keyword or a guessed intent.

## 2. File and sandbox isolation

- `src/server/routes/projects.ts` creates `id: randomUUID()` and binds `userId: authUser.id`; `ownerProject` checks both project ID and owner.
- `src/storage/project-files.ts` stores files in the private `project-files` bucket under `${projectId}/${relativePath}` and downloads only the requested project's prefix.
- `src/preview/e2b-service.ts` stores E2B IDs at `e2b:sandbox:${projectId}` and framework metadata at `e2b:framework:${projectId}`. Live sandboxes and `warmingSandboxes` are Maps keyed by `projectId`.
- `src/server/routes/build.ts` recovers build sessions and stored files using the current `projectId` and `userId`; never change this to a global/latest-project lookup.
- A paused sandbox can be resumed only from the Redis record for that same project. If the snapshot is gone, LampCode creates a fresh sandbox and restores only that project's persisted files.
- Framework compatibility is checked before reuse. A Vite sandbox is not reused for Next.js, and Next.js fails closed if its Ubuntu candidate ID is not configured.

Regression coverage: `scripts/project-isolation.test.ts` guards the UUID/owner, storage prefix, Redis key, warm-lock, framework compatibility and build-recovery boundaries.

## 3. Template families — do not confuse the old image with the Ubuntu candidates

The legacy Node 20 Vite image remains in source: `e2b-template/template.ts` still exports the legacy Dockerfile and `e2b-template/build.ts` still builds `lampcode-vite`. It was not overwritten or deleted.

The Ubuntu 24.04 candidates are separate:

- Vite/React: `createUbuntuBaseTemplate()` + `ubuntuTemplate` in `e2b-template/template.ts`, built by `e2b-template/build-ubuntu.ts` as `lampcode-vite-ubuntu24`.
- Next.js App Router: `ubuntuNextTemplate` in `e2b-template/template-nextjs-ubuntu.ts`, built by the same builder as `lampcode-nextjs-ubuntu24`.
- The old Node 20 Next.js scaffold source also remains at `e2b-template/template-nextjs.ts`; the Ubuntu builder selects the Ubuntu Next template.

Backend selectors:

- React/Vite: `E2B_TEMPLATE_ID`; absent this variable, the compatibility fallback remains `lampcode-vite` (legacy Node 20). Set it to `lampcode-vite-ubuntu24` only after the candidate image is built and verified.
- Next.js: `NEXTJS_TEMPLATE_ID` must be an exact verified `lampcode-nextjs-ubuntu24` candidate. There is no silent fallback to Vite or the legacy Next image.

Do not change production selectors just because a template ID has been added to an IDE `.env`. The named image must exist in the E2B account used by the live backend.

## 4. Ubuntu runtime and dependencies

Both Ubuntu candidates use the E2B native image builder. They provide Ubuntu 24.04, pinned Node 22.23.5, Python 3.12, build utilities, a dedicated Python venv at `/opt/lampcode-python`, Playwright/Chromium tooling and framework-specific scaffolds.

The base Python venv contains FastAPI, Uvicorn, Supabase and python-dotenv. CrewAI, LangGraph, LangChain integrations, APScheduler, Exa and data-science packages are intentionally not baked into every Ubuntu image. For Python apps, add a minimal pinned `requirements.txt` and use the `shell` tool to run `/opt/lampcode-python/bin/python3 -m pip install -r requirements.txt`; the shell approval gate must be shown and approved. The current runtime does not auto-install Python requirements. Never use system pip, `sudo pip`, VCS/URL dependencies or untrusted indexes.

For React/Vite and Next.js, `installExtraDependencies()` detects validated package names from generated dependency declarations and static JS/TS imports, then installs up to 12 missing npm packages with `npm install --no-save` before the preview health check. Do not overwrite the baked `package.json`, lockfiles or framework config. Dynamic imports/computed `require()` calls may not be detected, so verify those cases.

Optional 3D/motion packages (Three.js, React Three Fiber, Drei, Motion, GSAP, Lenis and Spline) are deliberately project-scoped, not preinstalled in every image. The `animation-expert` skill says when to add them; only install what the requested experience uses.

OS packages are allowed only through the root-owned `/usr/local/bin/lampcode-apt` wrapper. The shell policy requires explicit user approval for those operations and refuses general root/sudo commands.

## 5. Create, resume, pause and recover

1. A new project is created first; its UUID becomes the only key for sandbox creation and source storage.
2. `prewarmSandbox(projectId, framework)` warms in parallel with generation. Concurrent callers for the same project share the `warmingSandboxes` promise.
3. `createPreviewSandbox(sessionId, projectId, framework, files)` acquires the sandbox for that project, writes files, installs any detected npm extras, then checks/restarts the selected dev server.
4. The active sandbox lifetime is one hour by default (`SANDBOX_RUN_TIMEOUT_MS`, refreshed each build turn).
5. When the build socket disconnects, the pause grace is 15 minutes by default (`SANDBOX_GRACE_MS`); a reconnect cancels the pending pause. It is not paused immediately.

**Multi-replica limitation:** `warmingSandboxes` and `pendingPauseTimers` are in-process maps, not distributed leases. They prevent duplicate acquisition within one backend process only. Before running multiple API workers/replicas, add Redis token-owned create/resume locks (TTL + heartbeat + compare-token release) and a shared project activity lease so one replica cannot pause another replica's active preview. Test the race with two independent backend instances. Cross-project IDs/storage remain isolated regardless; this caveat is same-project concurrency reliability.
6. `pauseSandbox(projectId)` snapshots the same project's E2B sandbox and drops the process reference while retaining its Redis ID.
7. Redis metadata expires after 25 days; E2B paused snapshots have a 30-day provider lifetime. If Redis metadata or the snapshot is unavailable, restore from the private Supabase project-files prefix into a new sandbox. This is same-project source recovery, not cross-project reuse.

## 6. Runtime ports and health

- React/Vite: Vite on :5173; an optional Node/Hono or Python/FastAPI backend on :3001, proxied by Vite.
- Next.js: Next dev server and App Router Route Handlers on :3000; no second Hono/FastAPI process is started for Next.js.
- A URL is not handed out just because E2B accepted a background command. Wait for framework readiness, check/restart the dev server, and surface backend startup errors.
- Use `sandbox.getHost(port)` for the preview host. Never hardcode an E2B hostname.
- Preview `.env` is injected by the backend before the relevant server boots. Never let the model read `.env`; shell output is redacted and sensitive reads are refused.

## 7. Debug checklist

1. Confirm the request's `projectId` and owner before looking at Redis or storage.
2. Check `e2b:sandbox:${projectId}` and `e2b:framework:${projectId}`; never inspect a user-global/last-used sandbox as a substitute.
3. Compare saved and requested framework before resuming.
4. Check whether the `warmingSandboxes` entry is still active; concurrent callers should await the same promise.
5. Check template selector variables and confirm the exact candidate image was actually built and verified in E2B.
6. Check dependency-install output, dev-server logs, backend logs and readiness probe separately.
7. If snapshot recovery fails, restore `downloadProjectFiles(projectId)` and only that project's persisted files.

## 8. Do / don't

DO: allocate a new project UUID for every new app · scope files/Redis/maps/recovery to that ID · resume only when a user opens the selected saved project · verify framework compatibility · keep dependency installs project-local and approval-gated where required · run real preview/browser checks.

DON'T: key sandboxes by project title/prompt/user ID · reuse the previous app because the new prompt sounds similar · reuse Vite for Next.js · auto-install arbitrary Python requirements · rewrite template-owned manifests/config · expose secrets to shell output · treat an E2B image ID as proof that the image was rebuilt.
