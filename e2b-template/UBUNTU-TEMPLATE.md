# Ubuntu 24.04 E2B template candidate

**Status:** isolated candidate / proof of concept. It is not the production default.

## What this candidate changes

- Keeps Ubuntu 24.04 as the final sandbox OS.
- Copies Node.js 22.23.5 and npm from the official version-pinned Node image in a multi-stage build.
- Includes common Linux build utilities (Git, curl, compiler toolchain, package/config utilities, SQLite CLI, ripgrep).
- Installs the existing Python backend/agent package baseline into `/opt/lampcode-python`, a dedicated virtual environment. The OS-managed Python installation is not modified by pip, and `python3` / `pip` resolve to this environment.
- Reuses the exact same LampCode Vite scaffold, internal Playwright tooling, Chromium path, Vitest setup, type-check configuration and render probe as the existing production template.

The candidate deliberately does not add new LLM tools or inject extra system/tool descriptions into prompts. Runtime capabilities remain available to the backend; model-facing tools stay task-scoped.

## Build and verify

Create `e2b-template/.env` (this path is gitignored) with:

```dotenv
E2B_API_KEY=your_E2B_key
E2B_UBUNTU_TEMPLATE_ID=lampcode-vite-ubuntu24
E2B_VERIFY_TEMPLATE_ID=lampcode-vite-ubuntu24
E2B_EXPECT_UBUNTU=true
```

Then run:

```bash
cd e2b-template
npm install
npm run build:ubuntu24
npx tsx verify-template.ts
```

The build script refuses template IDs outside the `lampcode-vite-ubuntu24` candidate namespace. A successful image build is not sufficient: the verification script starts a real E2B sandbox and checks the base OS, Node/npm, Python virtual environment, Git/build utilities, writable project dependencies, Vitest, TypeScript, Playwright/Chromium and the live render probe.

Alternatively, use the manually triggered **E2B Ubuntu 24.04 Template** GitHub Actions workflow after adding `E2B_API_KEY` as a repository Actions secret. The workflow is manual-only because template builds consume E2B resources.

## Promotion / rollback

Do not change production configuration during the POC. After the build and live verification pass, set `E2B_TEMPLATE_ID=lampcode-vite-ubuntu24` only in a staging backend and run a representative full-stack canary. The existing backend selector already reads `E2B_TEMPLATE_ID`; no new model tool or prompt change is required.

Promote to production only after the canary verifies React/Vite preview, Node backend, Python backend, package installation, type checks, Vitest, Playwright render and logs. Roll back by restoring `E2B_TEMPLATE_ID=lampcode-vite`. Existing production template and snapshots remain untouched throughout this candidate build.
