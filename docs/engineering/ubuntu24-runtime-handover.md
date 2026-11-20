# LampCode Ubuntu 24.04 Runtime — Architecture & Operations Handover

**Reviewed:** 18 November 2026  
**Implementation branch:** `feat/e2b-ubuntu24-template-poc`  
**Pull request:** [#44 — isolated Ubuntu 24.04 E2B runtime candidates](https://github.com/thefani1122-source/Lampcode/pull/44)  
**Current state:** Draft / not merged. Production selectors remain unchanged.

This document explains what was built, how its parts connect, what runs where, and what still needs account-level verification. It is intentionally an operational handover, not just a change list.

---

## 1. The most important architecture distinction

There are **three separate runtime environments**. They must not be confused:

1. **LampCode platform** — the product users log into. Its React/Vite frontend is hosted separately from its Node.js/Hono API backend. In the current deployment setup, the frontend is on Vercel and the backend is on AWS. This PR does not migrate either one.
2. **Generated-app preview** — a temporary, isolated Ubuntu machine created through E2B for each user's project. The AI writes the app's files there and LampCode starts the relevant development server. This is what the Ubuntu work changes.
3. **Generated-app deployment** — when the user asks to deploy, LampCode sends the generated app files to that user's connected deployment provider (currently the Vercel path is implemented). This is independent from hosting the LampCode platform itself.

The Ubuntu template is **not** the server that hosts LampCode's API, and installing a tool in the Ubuntu template does not install it on the AWS backend.

## 2. End-to-end request flow

```text
User prompt in LampCode
        |
        v
LampCode frontend (React/Vite, hosted on Vercel)
        |
        v
LampCode API (Node.js + Hono, hosted on the backend host)
        |
        v
Framework selection
  - React/Vite: default / explicit Vite, Hono, Express or FastAPI request
  - Next.js: explicit Next.js request, or configured Next default
  - TanStack Start: currently rejected (no verified runtime yet)
        |
        v
Template selection
  - React/Vite -> E2B_TEMPLATE_ID (production fallback: lampcode-vite)
  - Next.js    -> NEXTJS_TEMPLATE_ID (must be explicitly configured)
        |
        v
E2B creates / resumes an isolated project sandbox
        |
        v
AI writes project files -> dependencies -> dev server starts
        |
        v
Readiness probe + preview URL + browser/render checks
        |
        v
User edits / agent fixes / checks are repeated against the project
        |
        v
On deploy: rescan current files for security -> create provider deployment
        |
        v
Wait for provider READY -> smoke-test live URL and real API routes
```

Relevant code locations:

| Responsibility | Code |
|---|---|
| Prompt-to-framework classification | `src/agents/framework-selection.ts` |
| Template selection, sandbox lifecycle, preview servers | `src/preview/e2b-service.ts` |
| Prevent reusing a sandbox for a different framework | `src/preview/framework-compat.ts` |
| Shared Ubuntu base and Vite image | `e2b-template/template.ts` |
| Next.js Ubuntu image | `e2b-template/template-nextjs-ubuntu.ts` |
| Build candidate images | `e2b-template/build-ubuntu.ts` |
| Verify a real image in a real sandbox | `e2b-template/verify-template.ts` |
| Framework-native deployment scaffold | `src/deploy/vercel.ts`, `src/deploy/nextjs-scaffold.ts` |
| Post-deploy smoke checks | `src/deploy/smoke.ts` |
| Security re-check before sending code to Vercel | `src/agents/tools/deploy-app.ts` |

## 3. What the Ubuntu 24.04 machine contains

Both Ubuntu candidates are built with the E2B SDK's **native image builder API**. They are not built by editing `e2b.Dockerfile`; that file is not the source of these candidate images.

### Operating system and base utilities

- Ubuntu 24.04.
- Git and curl for source/control and network access.
- Build essentials, GCC, Make, pkg-config and native headers/libraries for packages with native extensions.
- Python 3 full runtime, pip and venv support.
- SQLite CLI, zip/unzip, jq, ripgrep, xz utilities and process tools.

### Node.js

- Node.js **22.23.5** is installed from the official Node distribution.
- The builder chooses the correct binary for amd64 or arm64.
- It verifies the download against an architecture-specific SHA-256 digest before extracting it.
- This gives generated apps a consistent Node runtime rather than relying on whichever Node version Ubuntu happens to package.

### Python

- System Python is kept externally managed (PEP 668 is not bypassed with global `pip install`).
- LampCode creates a dedicated environment at `/opt/lampcode-python`.
- The base Python packages are FastAPI, Uvicorn, Supabase and python-dotenv.
- The virtual environment is added to the sandbox PATH.

This separation matters: Python app dependencies can be installed into the app's own venv without damaging Ubuntu's system Python.

### Installing additional Linux packages

The project user is not given a general root shell. The image installs `sudo` plus a root-owned helper at `/usr/local/bin/lampcode-apt`. That helper permits only:
- `sudo -n /usr/local/bin/lampcode-apt update`
- `sudo -n /usr/local/bin/lampcode-apt install <package> [package ...]`

The wrapper validates each argument as an Ubuntu repository package name/version and runs `apt-get install -y --no-install-recommends`. It rejects local `.deb` paths, arbitrary flags, apt removals, source-list edits and all other root commands. In LampCode's agent shell policy, the two allowed operations pause for explicit user approval; arbitrary `sudo`, `su`, service management and privileged commands remain refused. The privilege boundary is the isolated E2B project VM, not the AWS backend or host machine.

Example request the agent can use (after the user approves):
```bash
sudo -n /usr/local/bin/lampcode-apt update
sudo -n /usr/local/bin/lampcode-apt install libcairo2-dev libpq-dev
```

The live E2B verifier performs a real package install of `tree` and confirms that a local `.deb` argument is rejected. This check runs in the throwaway verification sandbox, not in production.

### Browser QA and developer tools

- Playwright and Chromium are installed in a shared tools directory.
- A reusable browser-render check is included.
- Global `tsx` and TypeScript utilities are available for development scripts.
- Vite is included in the Vite candidate. The Next.js project carries its framework dependencies in its own scaffold.

Heavy optional libraries (for example CrewAI, LangGraph, Three.js, Motion/GSAP and other specialist packages) are **not** all installed in every base image. They are added to the relevant project when required. This reduces image size, sandbox cold-start time and unnecessary dependency exposure.

## 4. Frameworks and ports

| Project type | Preview runtime | Port | State |
|---|---|---:|---|
| React / Vite | Vite dev server | 5173 | Existing default path; Ubuntu candidate is separate |
| React + Hono | Vite plus the project's Node/Hono API | 5173 + 3001 | Supported path; needs staging canary |
| React + FastAPI | Vite plus the project's Python API | 5173 + 3001 | Supported path; needs staging canary |
| Next.js App Router | Next.js dev server and Route Handlers | 3000 | Candidate implemented; needs real image + staging canary |
| TanStack Start | — | — | Deliberately disabled until its own image and verifier exist |

Framework selection is fail-closed for Next.js: if a Next.js runtime is requested but `NEXTJS_TEMPLATE_ID` is not configured in the backend, preview creation returns a clear error rather than quietly starting Vite and presenting the wrong framework.

A matching-looking template ID is not proof that the image exists or has passed verification. The operator must run the real E2B build/verifier first and only then set the selector in staging.

The preview manager also records the framework associated with a project's sandbox. It will not silently reuse a Vite sandbox for a Next.js project (or vice versa). Framework replacement is serialized so concurrent preview requests share one creation/replacement operation. The template is checked before an existing working preview is removed.

For Vite previews, LampCode patches the Vite server config where required for E2B's HTTPS preview host and WebSocket-based HMR. For Next.js, LampCode uses port 3000 and a longer cold-start readiness window.

## 5. How the sandbox lifecycle works

1. The backend checks that `E2B_API_KEY` is configured.
2. LampCode resolves the framework to a template ID.
3. It checks whether the project already has a live sandbox, a sandbox warming up, or a resumable saved sandbox snapshot.
4. Redis stores project-to-sandbox metadata and framework metadata as a cache. It is not the source of truth. Redis operations are bounded; a Redis outage should not leave a request waiting forever.
5. The sandbox is created/resumed, project environment values are injected, and the generated files are written.
6. LampCode starts the correct dev server and probes it until it responds (Vite: up to 30 seconds; Next.js cold start: up to 90 seconds).
7. On a resumed sandbox, LampCode checks whether the dev process is still alive and restarts it when necessary.
8. If the project contains a separate Node/Hono entrypoint (`src/server/index.ts` / `src/server/app.ts`) or Python entrypoint (`src/server/main.py`), the matching backend is started inside the sandbox. The Next.js App Router uses its own server/routes instead of a second Hono process.

The warm-up promise lock prevents the initial parallel prewarm and file-write paths from creating two sandboxes for the same project.

## 6. What happens on deployment

Preview and deployment are different operations. A working E2B preview does not mean the app is already deployed.

Before the Vercel call, LampCode:
- takes the current project file snapshot (including deletions);
- reruns security verification against that exact snapshot, rather than trusting an older build-time result;
- blocks deployment if verification cannot complete or if unresolved high/critical findings exist;
- detects the actual app shape (Next.js App Router, FastAPI, Hono or static/Vite);
- reconstructs the build/config/UI files that are part of the E2B image and therefore may not be present in the AI-generated file list;
- sends the matching Vercel framework preset and build configuration;
- waits for Vercel to finish; and
- smoke-tests the live URL. A successful API request that merely creates a deployment is not treated as proof that the app works.

Next.js is sent as the native `nextjs` framework with `next build`. The Next.js scaffold includes an App Router layout, providers and a per-provider QueryClient (not a process-wide singleton), plus the shared UI primitives/styles. For API checks, the route targets are derived from the actual App Router route files.

Vite/Hono and FastAPI have their own deploy shapes. The Vite scaffold also materializes the shared CSS, UI primitives and utility files required outside the E2B image.

**Important:** the Next.js Vercel path has automated contract tests in this branch, but it has not yet been exercised against a real Vercel project using a user's connected Vercel account. That staging test is still required.

## 7. Exact configuration and which account owns it

These are different credentials and must not be mixed up.

| Name | Where it belongs | Purpose |
|---|---|---|
| `E2B_API_KEY` | LampCode backend secret store | Allows the live backend to create/resume project sandboxes |
| `E2B_API_KEY` | GitHub repository Actions secret | Allows the manual workflow to build candidate images and verify real E2B sandboxes |
| `E2B_TEMPLATE_ID` | LampCode backend environment | Selects the React/Vite preview image; currently keep `lampcode-vite` until rollout is approved |
| `NEXTJS_TEMPLATE_ID` | LampCode backend environment | Opts full-stack Next.js projects into the Next candidate; keep unset until staging passes |
| `E2B_UBUNTU_TEMPLATE_ID` | Manual workflow input / local template build | Chooses which candidate image to build |
| `E2B_VERIFY_TEMPLATE_ID` | Manual workflow / verifier | Tells the verifier which candidate to boot |
| `E2B_EXPECT_UBUNTU` | Verifier environment | Requires Ubuntu 24.04 checks |
| `E2B_EXPECT_FRAMEWORK` | Verifier environment | Must be `vite` or `nextjs` and checks that framework's app/port |
| Vercel OAuth/access token | User's connected Vercel integration in LampCode | Deploys that user's generated app to their Vercel account |
| Supabase credentials | User/project integration settings, when applicable | Connects the generated app's own data layer; not required to build the Ubuntu image |

Do not put any API key in the prompt, a source file or this documentation. Never commit `e2b-template/.env`.

## 8. What you need to do to finish account-level verification

These are the remaining steps that cannot be completed using repository code access alone.

### A. Confirm/add the GitHub Actions secret

1. Open the LampCode repository on GitHub.
2. Go to **Settings → Secrets and variables → Actions**.
3. Check whether a repository secret named `E2B_API_KEY` exists. If not, create it using the key from your E2B account.
4. Do not send the key in chat and do not put it into a committed file.

A repository secret is hidden from normal GitHub reads; this handover does not claim to have inspected its value. The workflow itself checks that it is present before starting a build.

### B. Build and verify each candidate

1. A push to the feature branch that changes a runtime/template path automatically starts a matrix run for both candidate IDs. Docs-only and deploy-only changes do not spend E2B build minutes.
2. For a targeted manual run, open **Actions → E2B Ubuntu 24.04 Template** on `main`, choose **Run workflow**, select `source_ref=feat/e2b-ubuntu24-template-poc`, and choose one `template_id`.
3. A green audit step is not enough. Each candidate must complete both **Build isolated Ubuntu template candidate** and **Start a real sandbox and verify capabilities**. The verifier checks OS/toolchain, Python venv, apt package installation, permissions, Chromium, Vitest, TypeScript, dev-server readiness and browser rendering.
4. If a matrix run is already in progress, inspect it before launching another one; do not create duplicate E2B builds just to refresh the UI.

A green image-build step alone is not sufficient; the real sandbox verifier must also pass. The candidate IDs do not overwrite the existing `lampcode-vite` image.

### C. Run staging canaries

After both candidate verifications pass, configure the staging backend's secret/environment store (not the frontend) with:

```dotenv
E2B_TEMPLATE_ID=lampcode-vite-ubuntu24
NEXTJS_TEMPLATE_ID=lampcode-nextjs-ubuntu24
```

Then build and preview real sample applications for:
- Vite + Hono, including a real API request;
- Vite + FastAPI, including a real Python API request;
- Next.js App Router, including page rendering and any declared Route Handlers.

Also connect a staging Vercel account and deploy at least one sample of each supported deployment shape. Check the final URL, static assets, server routes and smoke-check output. Keep production selectors untouched throughout staging.

### D. Production promotion

Only after staging canaries succeed should the same two selectors be updated in the production backend environment. This is a rollout decision; this PR has not changed the production values.

**Rollback:** restore `E2B_TEMPLATE_ID=lampcode-vite` and unset `NEXTJS_TEMPLATE_ID`. The existing production fallback remains available; no database migration or user-project file conversion is part of this change.

## 9. Verification state on this branch

**Current implementation branch:** `feat/e2b-ubuntu24-template-poc`  
**Current PR:** [#44 — isolated Ubuntu 24.04 E2B runtime candidates](https://github.com/thefani1122-source/Lampcode/pull/44)  
**Status:** Draft / not merged. The main branch and production selectors remain unchanged.

### CI and E2B candidate evidence

The original Ubuntu candidate work is verified by successful real E2B build-and-sandbox runs:

- [Run #44479352463](https://github.com/thefani1122-source/Lampcode/actions/runs/44479352463) — both Vite and Next.js Ubuntu 24.04 candidate images built and their real E2B sandbox verifiers passed.
- [Run #44485029355](https://github.com/thefani1122-source/Lampcode/actions/runs/44485029355) — expanded API checks passed for both candidates, including FastAPI, Hono, Vite `/api` proxy and Next.js Route Handler checks.
- [Run #44485233954](https://github.com/thefani1122-source/Lampcode/actions/runs/44485233954) — final apt-metadata retry matrix passed for both candidates, including package install and local-`.deb` rejection.

The apt retry only retries Ubuntu repository metadata refresh for transient mirror-sync inconsistencies. It does not disable GPG signatures or package-hash verification.

The full repository CI was also rerun after the deployment and regression-test changes:

- [Run #44650769538](https://github.com/thefani1122-source/Lampcode/actions/runs/44650769538) — TypeScript typecheck, the complete Cases suite, backend bundle build, production dependency audit and full dependency audit all passed. This run is on commit `ac62b611cfef5b14d2262d6b1f9ac5b16c0effde`; a subsequent test-only commit adds explicit lazy 3D dependency-install contract coverage and must receive its own green CI result before merge.

### Generated-app Vercel staging canaries

These are isolated test projects in the user's Vercel team. They are not the LampCode platform frontend, are not the AWS backend, and were not deployed to the user's production domain.

| Scenario | Deployment | Verified result |
|---|---|---|
| Vite + Hono | [Staging canary](https://lampcode-ubuntu24-vite-hono-canary-1r7qcgsql.vercel.app) | Homepage and Hono API returned HTTP 200 |
| Next.js App Router | [Staging canary](https://lampcode-ubuntu24-nextjs-canary-aufjdb5ol-lampcode-s-projects.vercel.app) | Homepage and Route Handler returned HTTP 200 |
| Standalone FastAPI | [Staging canary](https://lampcode-ubuntu24-fastapi-canary-28yg3tgbv-lampcode-s-projects.vercel.app) | Homepage and FastAPI endpoint returned HTTP 200 with a valid Python project manifest |
| Vite + FastAPI Services | [Staging canary](https://lampcode-ubuntu24-vite-fastapi-services-canary-j2ylrg2cx.vercel.app) | Vite build and separate FastAPI environment both completed; homepage and `/api/health` returned HTTP 200 |
| Vite + FastAPI + 3D dependencies | [Staging canary](https://lampcode-ubuntu24-vite-fastapi-services-canary-r3jhdsahy.vercel.app) | React 19, Three.js, React Three Fiber v9 and Drei v10 compiled together; homepage and FastAPI health endpoint returned HTTP 200 |

The last two canaries directly validate the provider-side Services layout used by the new `vite-fastapi` deployment shape. The Services config uses the documented Vercel shape: a top-level `services` map with per-service `root` (and the Python `entrypoint`), plus rewrites that send `/api/:path*` to FastAPI and the remaining paths to Vite. The project framework is `services`; per-service `framework` properties are intentionally omitted. See [Vercel Services](https://vercel.com/docs/services), [Services routing](https://vercel.com/docs/services/routing) and [rewrites](https://vercel.com/docs/routing/rewrites).

The 3D canary build transformed 593 modules and produced a roughly 1.1 MB minified JavaScript bundle (about 306 KB gzip). Vercel emitted its normal large-chunk warning; the build still completed successfully. The canary confirms dependency compatibility and deployment packaging, but it was not a screenshot-based visual/interaction test of a rendered 3D scene. For production-sized 3D experiences, lazy-load the Canvas/scene and split the bundle.

### FastAPI + Vite deployment changes now covered

The additional deployment gap found during staging review is fixed in `src/deploy/vercel.ts`:

- A generated project with both a Vite UI and `src/server/main.py` now resolves to `vite-fastapi`, rather than incorrectly treating the entire project as FastAPI-only.
- The scaffold isolates frontend files under `frontend/` and Python files under `backend/`.
- It generates a Vercel Services config with the API rewrite before the frontend catch-all.
- Root `requirements.txt` and `src/server/requirements.txt` entries in the supported PEP 508 subset are merged into the backend `[project].dependencies` in `pyproject.toml`. Existing project metadata and an app-owned Vercel entrypoint are preserved.
- Pip directives, direct URLs/local paths, unsupported TOML dependency shapes and conflicting global Vercel build settings fail closed rather than being silently discarded or overwritten.
- Standalone FastAPI deployments also receive requirement-to-`pyproject.toml` mapping.
- Regression tests assert that Three.js, React Three Fiber and Drei dependencies survive the frontend scaffold and that the Python requirement files are not uploaded as competing raw manifests.

### Agent, skill and 3D behaviour

The tool-selection path was reviewed in the branch:

- The user request is first classified by a model as a query/inspection or a build; the deterministic fallback only applies after classifier failure.
- `AGENTIC_BUILD_ENABLED` defaults to enabled unless explicitly set to `false` or `0`. `BUILD_PLANNING_ENABLED` also defaults to enabled. The planner prepares a product blueprint and file plan; the agentic generator then gets the tools needed to build and verify its work.
- The gateway does not force a fixed tool. It exposes the eligible tool definitions and lets the provider's automatic tool-choice behaviour select among them. Dispatcher executes requested tools, passes their results back to the model, and continues until the model finishes or reaches the configured turn/cost budget.
- Connected MCP servers are filtered for relevance to the user's request. Read-only tools may be called directly; writes/destructive actions pass through the approval boundary. Query mode has a separate read-only allowlist.
- Specialist skill descriptions are indexed in the prompt; the model decides semantically when to load a full skill with `load_skill`. The animation/3D skill is still present and describes Motion, GSAP, Lenis, Three.js/React Three Fiber/Drei and Spline.
- Heavy optional 3D/animation packages are not installed in every base app. Generated imports and declared dependencies are scanned and missing package names are installed before the preview server starts, with name validation and a per-build cap. A new regression case pins the scoped-package detection and install-before-server ordering.

This means the model can decide which *available* tools and skills best fit a request; it cannot call tools that were filtered out, are not connected, or are denied by the safety/approval policy.

### What remains after this code handover

- The user still needs to deploy the backend branch to the AWS staging environment and run one end-to-end build from the live LampCode UI through the AWS API to E2B and the user's Vercel account. No AWS deployment was done here.
- Keep `E2B_TEMPLATE_ID=lampcode-vite` and `NEXTJS_TEMPLATE_ID` unset in production until the user completes that rollout decision.
- The feature branch must receive a green CI run after the most recent lazy-3D-install test commit before merge. The PR remains Draft until that CI is green and the AWS staging end-to-end request is checked.

## 10. What this PR does not claim

- It does not move the LampCode frontend or backend to Ubuntu.
- It does not migrate the production E2B template.
- It does not enable Next.js in production.
- It does not enable TanStack Start.
- It does not prove real E2B image builds or real Vercel deployment until the account-backed steps above have passed.
- It does not add a new autonomous agent/self-fix product subsystem. It preserves the existing verification/security integration and adds framework/runtime/deploy alignment around it.

The PR should remain Draft until the external verification gates are complete and the dependency audit situation has been reviewed.
