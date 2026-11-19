# Ubuntu 24.04 E2B runtime candidates

**Status:** isolated Vite and Next.js candidate images. Neither is a production default until the manual E2B build, live sandbox verifier and staging canary pass.

## Shared Ubuntu base

Both framework images use E2B SDK 2.55.0's native Ubuntu image builder API and share:
- Ubuntu 24.04 as the final OS.
- Official Node.js 22.23.5 binary, downloaded for amd64/arm64 and verified against pinned SHA-256.
- Python 3 and pip inside `/opt/lampcode-python`, a dedicated virtual environment. System Python is left externally managed.
- Minimal Python essentials only: FastAPI, Uvicorn, Supabase and python-dotenv.
- Git, curl, compiler/build tools, pkg-config, database native headers, SQLite CLI, unzip/zip, jq, ripgrep, tree and process tools.
- A restricted root-owned apt wrapper: the project user can request Ubuntu repository packages through `sudo -n /usr/local/bin/lampcode-apt update` and `sudo -n /usr/local/bin/lampcode-apt install <package>`. LampCode's shell policy requires explicit user approval for both operations. Arbitrary sudo/root commands, local `.deb` files and apt removals remain refused.
- Playwright + Chromium and one shared framework-neutral render-check tool.
- Global TypeScript and tsx utilities.

Heavy packages such as CrewAI, LangGraph, LangChain, Three.js, React Three Fiber, Spline, GSAP, Motion and Lenis are **not** baked into every project. The preview backend installs optional npm imports and Python requirements into the isolated project sandbox before its server starts. This avoids paying cold-start and dependency costs for apps that do not use them, and keeps framework/tool catalogues out of the model prompt unless relevant.

## Candidate IDs

- Vite/React: `lampcode-vite-ubuntu24`
- Next.js App Router: `lampcode-nextjs-ubuntu24`

## Installing optional OS packages

Generated apps sometimes need native Linux libraries that should not be baked into every project image. After the user approves the shell action, the agent can request:

```bash
sudo -n /usr/local/bin/lampcode-apt update
sudo -n /usr/local/bin/lampcode-apt install libcairo2-dev libpq-dev
```

The root-owned wrapper validates repository package names and invokes non-interactive apt. It does not provide a general root shell, accept local package files, change apt sources or remove packages. The verifier installs `tree` through this exact path and tests that local `.deb` arguments are rejected.

## Build and verify

Add these values to `e2b-template/.env` (gitignored):

```dotenv
E2B_API_KEY=your_private_key
E2B_UBUNTU_TEMPLATE_ID=lampcode-vite-ubuntu24
E2B_VERIFY_TEMPLATE_ID=lampcode-vite-ubuntu24
E2B_EXPECT_UBUNTU=true
E2B_EXPECT_FRAMEWORK=vite
```

Then run:

```bash
cd e2b-template
npm install
npm run build:ubuntu24
npx tsx verify-template.ts
```

For the Next.js candidate, change both template IDs to `lampcode-nextjs-ubuntu24` and set `E2B_EXPECT_FRAMEWORK=nextjs`.

The verifier starts a real E2B sandbox, checks the OS/toolchain and package layout, runs Vitest and TypeScript, starts the actual framework dev server on its preview port, and then opens it using the same Playwright/Chromium QA browser. A green image build alone is not sufficient.

The manual GitHub Actions workflow can run the same process after adding `E2B_API_KEY` as a repository Actions secret. Do not paste the key into chat or commit `.env`.

## Framework and deployment model

- Frontend-only pages remain Vite/React by default: fast client-side builds with low runtime overhead.
- New full-stack applications can use Next.js App Router as the default only after the Next.js Ubuntu image is built, verified and enabled in staging through `NEXTJS_TEMPLATE_ID`.
- Explicit React + Hono remains available for projects that need a separate API service; Python/FastAPI remains available for Python backend projects.
- Next.js runs a single Node process on port 3000 and uses Route Handlers/server-side code rather than a second Hono process.
- Vite runs on 5173 and preserves its Hono/FastAPI companion service on 3001.
- The preview URL/QA paths use the detected framework port; the app files remain framework-native for deployment.

## Promotion and rollback

Do not alter production configuration during the POC. After both candidates are live-verified, set `E2B_TEMPLATE_ID=lampcode-vite-ubuntu24` and `NEXTJS_TEMPLATE_ID=lampcode-nextjs-ubuntu24` only in a staging backend. Run real Vite+Hono, Vite+FastAPI and Next.js canaries. Then promote the same selectors to production.

Rollback: restore `E2B_TEMPLATE_ID=lampcode-vite` and keep `NEXTJS_TEMPLATE_ID` unset. No migrations or user-project conversions are required; projects keep their framework metadata and stored files.

## Full architecture and operations handover

See [LampCode Ubuntu 24.04 Runtime — Architecture & Operations Handover](../docs/engineering/ubuntu24-runtime-handover.md) for the full request-to-preview/deploy flow, runtime boundaries, environment variables, staging sequence, rollback steps and current verification state.
