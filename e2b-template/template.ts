import { Template } from 'e2b'

// ── Lampcode preview sandbox — v2 template definition ────────────────────────
// We bake a known-good baseline scaffold (correct vite.config.ts, tsconfig,
// index.html, base package.json) INTO the image and pre-install node_modules.
// Why: generating build-config from scratch on every build was a reliable
// source of breakage (the allowedHosts / HMR / double-Vite bugs all came from
// LLM-written config). Now the LLM only writes src/** app files on top of this
// baseline; the backend (src/preview/e2b-service.ts) writes those files, runs
// `npm install` (fast — deps already cached here), and starts Vite itself.
//
// IMPORTANT: we deliberately set NO start command / CMD here — the backend owns
// starting Vite (`npx vite --host 0.0.0.0 --port 5173`). A baked CMD would race
// it on port 5173 (the "double-Vite" bug).
//
// Files are written by base64-decoding into place: `echo '<b64>' | base64 -d`.
// This is a single-line RUN that works in BOTH classic and BuildKit Dockerfile
// parsers (multi-line heredocs only work under BuildKit, and we can't assume
// which parser E2B uses), and needs no COPY build-context. base64's alphabet
// has no shell metacharacters, so the content can't break the command.

const PKG_JSON = `{
  "name": "lampcode-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 5173",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@supabase/supabase-js": "^2.45.0",
    "hono": "^4.6.3",
    "@hono/node-server": "^1.13.1",
    "zod": "^3.23.8",
    "mongoose": "^8.7.0",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "gsap": "^3.12.5",
    "motion": "^11.11.0",
    "lenis": "^1.1.14",
    "@tsparticles/react": "^3.0.0",
    "@tsparticles/slim": "^3.5.0",
    "@splinetool/react-spline": "^4.0.0",
    "@react-three/fiber": "^8.17.10",
    "@react-three/drei": "^9.114.3",
    "three": "^0.169.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.10",
    "typescript": "^5.5.4",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/bcryptjs": "^2.4.6",
    "@types/three": "^0.169.0"
  }
}`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pre-baked. Do not edit from generated apps.
//  - allowedHosts: E2B serves the preview from a dynamic *.e2b.app host.
//  - hmr.clientPort 443 + wss: the iframe loads over HTTPS, so HMR must connect
//    back through E2B's TLS endpoint, not ws://localhost:5173.
//  - strictPort: crash loudly instead of silently moving to 5174 (the backend
//    health-checks exactly :5173).
//  - watch.usePolling: files arrive via the E2B API (files.write), whose
//    filesystem events are unreliable for inotify — without polling, HMR
//    doesn't notice the new files and the preview goes stale.
//  - proxy /api -> :3001: when the app ships a real backend (Hono/Node), the
//    backend listens on 3001 and the frontend calls same-origin /api/*; Vite
//    forwards those to it. No CORS, one public URL.
export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})`

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}`

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>`

const INDEX_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`

const APP_TSX = `export default function App() {
  return <div style={{ padding: 24, fontFamily: 'system-ui' }}>Loading…</div>
}`

const STYLES_CSS = `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }`

// Writes `body` to `path` inside the image via a single-line base64 decode.
const writeFile = (path: string, body: string): string => {
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  return `RUN mkdir -p "$(dirname ${path})" && echo '${b64}' | base64 -d > ${path}`
}

const dockerfile = [
  'FROM node:20-slim',
  'RUN apt-get update && apt-get install -y git curl ca-certificates python3 python3-pip && rm -rf /var/lib/apt/lists/*',
  'RUN npm install -g vite tsx typescript',
  // Python backends (FastAPI) run on the same :3001 the frontend proxies /api to.
  'RUN pip3 install --no-cache-dir --break-system-packages fastapi "uvicorn[standard]" supabase python-dotenv crewai langgraph langchain-anthropic apscheduler exa-py',
  'WORKDIR /home/user/app',
  writeFile('/home/user/app/package.json', PKG_JSON),
  writeFile('/home/user/app/vite.config.ts', VITE_CONFIG),
  writeFile('/home/user/app/tsconfig.json', TSCONFIG),
  writeFile('/home/user/app/index.html', INDEX_HTML),
  writeFile('/home/user/app/src/index.tsx', INDEX_TSX),
  writeFile('/home/user/app/src/App.tsx', APP_TSX),
  writeFile('/home/user/app/src/styles.css', STYLES_CSS),
  // Install once at build time so per-project cold start is just a fast
  // `npm install` of whatever extra deps the generated app declares.
  'RUN npm install',
].join('\n')

export const template = Template().fromDockerfile(dockerfile)
