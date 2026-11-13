---
name: frontend-sandbox
description: E2B React + Vite runtime rules, browser storage/network capabilities, and template-owned files for LampCode previews.
---

# Frontend Runtime — E2B React + Vite

The current LampCode preview runs the generated React application inside a persistent E2B Linux sandbox using Vite. This is NOT Sandpack or a browser-only mock environment.

## Runtime capabilities

- React 19, React DOM, Vite, TypeScript, Tailwind CSS 4 and the template's pre-baked UI primitives are available.
- The app runs in a real browser preview. Browser APIs such as `localStorage`, `sessionStorage`, `fetch`, `window.location`, and browser navigation APIs are available.
- Use `localStorage` or IndexedDB when the user asks for browser-local persistence or when the product is intentionally single-user/local-first. Do not replace a requested real database or backend with browser storage.
- Use same-origin `fetch('/api/...')` for an app backend exposed through the Vite proxy. Do not hardcode `localhost`, `127.0.0.1`, or sandbox-specific public hosts in browser code.
- External API calls may require CORS and network access. Never place private API keys or server credentials in browser code; route secret-bearing requests through the backend.
- Node APIs (`fs`, `path`, `process`) are server/build-time capabilities, not browser APIs. Never import Node-only modules into code that Vite bundles for the browser.

## File ownership

The E2B template owns its runtime and build configuration. Do not overwrite template-owned files such as:

- `package.json` and lockfiles
- `vite.config.ts` / `vite.config.js`
- `tsconfig.json` and `tsconfig.node.json`
- `index.html`
- `src/styles.css`
- `vitest.config.*` and `vitest.setup.ts`
- `src/lib/utils.ts` and `src/lib/queryClient.ts`

Generate the application entry point and product files required by the current prompt. The standard React entry is `src/index.tsx` (or an already-established entry point in an existing project) and the app component is typically `src/App.tsx`.

The baked `src/styles.css` contains Tailwind v4 and neutral design tokens. For a product-specific palette, create `src/theme.css` and import it after `./styles.css`; do not replace the baked stylesheet.

## Dependencies

Use packages already listed in the runtime manifest supplied in the system prompt. Do not invent package names or import libraries that are not available. If a truly necessary package is not pre-installed, declare it only through the supported generated dependency-manifest path; never overwrite the running template's package/config files with a guessed full manifest.

## Product behavior

- Choose browser storage, a real backend, or an external data source based on the user's explicit request and the authoritative build architecture.
- Keep loading, error, and genuinely empty states distinct. A failed API call must never be rendered as an ordinary empty list.
- Do not create mock/localStorage fallbacks for a broken real backend.
- Keep the UI usable on mobile and desktop, and verify the rendered app in the real browser preview.

## Common mistakes

1. Importing a Node-only module into browser code.
2. Hardcoding `http://localhost:3001` or an E2B hostname in frontend code.
3. Overwriting template-owned configuration or `src/styles.css`.
4. Treating an API/database error as a successful empty state.
5. Replacing requested server persistence with `localStorage`.
