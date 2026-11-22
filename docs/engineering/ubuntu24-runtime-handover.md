# LampCode Ubuntu 24.04 Runtime — Architecture & Operations Handover

**Reviewed:** 22 November 2026  
**Ubuntu template PR:** [#44 — merged 20 November 2026](https://github.com/thefani1122-source/Lampcode/pull/44)  
**Runtime / prompt PR:** [#46 — `fix/nextjs-runtime-prompt-consistency`](https://github.com/thefani1122-source/Lampcode/pull/46) (draft while this handover is updated).  
**Rollout state:** Both original Ubuntu candidates have a green E2B image + real-sandbox verification. The newer Next.js template revision in PR #46 adds shadcn files/dependencies and still needs its own rebuild + verifier run before selecting that revision in the live backend. Production selectors remain explicit environment settings.

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
Build architecture classification (PR #46): the model-owned classifier produces the selected frontend framework, backend runtime, database/persistence and required tool decisions. Prompt keyword/regex heuristics must not decide whether the build is Next.js, React/Vite, full-stack, local-only or Supabase-backed. A trusted server-side marker carries the classifier result into the framework selector. TanStack Start remains disabled until its own runtime and verifier exist.
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
- The dedicated /opt/lampcode-python venv is placed first in the generated-project user's login-shell PATH; Ubuntu's system Python remains externally managed. Each project sandbox has its own copy of this venv. Python requirements are not auto-installed by the current runtime. For CrewAI or LangGraph, add a minimal pinned requirements.txt and install it with /opt/lampcode-python/bin/python3 -m pip install -r requirements.txt through the shell tool's explicit approval flow. Do not use system pip, privileged installs, URLs/VCS references or extra package indexes.

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
| React / Vite | Vite dev server | 5173 | Ubuntu candidate built and real-sandbox verified; staging remains |
| React + Hono | Vite plus the project's Node/Hono API | 5173 + 3001 | Hono fixture/API passed in candidate verifier; real-user staging remains |
| React + FastAPI | Vite plus the project's Python API | 5173 + 3001 | FastAPI fixture/API passed in candidate verifier; real-user staging remains |
| Next.js App Router | Next.js dev server and Route Handlers | 3000 | Baseline candidate verified; PR #46's newer shadcn template revision still needs rebuild + staging |
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

The warm-up promise lock prevents the initial parallel prewarm and file-write paths from creating two sandboxes for the same project. Sandbox keys, source storage, in-process maps and recovery all use projectId. A new dashboard build allocates a fresh project UUID; selecting a saved card is the resume path. A prompt submitted inside an already-open workspace remains an edit to that selected project. See docs/engineering/project-and-sandbox-isolation.md.

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

1. This manual workflow is workflow_dispatch and builds one candidate ID per run. It checks out the supplied source_ref, runs the dependency audit, builds the selected image and starts a real sandbox for verification.
2. Open **Actions → E2B Ubuntu 24.04 Template**, choose **Run workflow**, leave `source_ref=main` after PR #46 is merged (or enter the exact reviewed branch while testing a draft), and choose one `template_id`. Run the workflow separately for each candidate ID.
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

**Baseline proof:** GitHub Actions [run #44485233954](https://github.com/thefani1122-source/Lampcode/actions/runs/44485233954), commit `3edc77d80285ff45b7dcb505325d265d2bf08e16`, completed successfully for both `lampcode-vite-ubuntu24` and `lampcode-nextjs-ubuntu24`. Both jobs built the image and booted a real E2B sandbox.

The successful verifier covered Ubuntu 24.04, Node 22.23.5, Python 3.12 and the dedicated venv, Chromium/Playwright, Vitest, TypeScript, production build, FastAPI HTTP, Hono HTTP on the Vite candidate, Next.js Route Handler HTTP, and non-blank browser rendering.

**Revision caveat:** the Vite candidate source in PR #46 is unchanged from that successful image commit. The Next.js candidate source changed after that run: PR #46 adds `shadcn@4.23.0`, `tw-animate-css`, `components.json` and a verifier step that runs `shadcn add accordion`. Therefore the current PR #46 Next.js template revision is not yet proven by run #44485233954.

After PR #46 is merged, rebuild and verify the current Next.js candidate from `main` using the manual workflow (`source_ref=main`, `template_id=lampcode-nextjs-ubuntu24`). Do not set or rely on `NEXTJS_TEMPLATE_ID` for this new revision until that workflow run passes both image build and real-sandbox verification.

PR #44's successful candidate runs prove that the old Node 20 production template was not destroyed; they do not prove a later, changed template image was rebuilt. Keep template source revision and E2B image revision aligned.
