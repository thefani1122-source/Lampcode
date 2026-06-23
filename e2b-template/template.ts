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
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "@tanstack/react-query": "^5.62.0",
    "lucide-react": "^0.460.0",
    "@radix-ui/react-dialog": "^1.1.2",
    "@radix-ui/react-dropdown-menu": "^2.1.2",
    "@radix-ui/react-label": "^2.1.0",
    "@radix-ui/react-select": "^2.1.2",
    "@radix-ui/react-separator": "^1.1.0",
    "@radix-ui/react-slot": "^1.1.0",
    "@radix-ui/react-tabs": "^1.1.1",
    "@radix-ui/react-toast": "^1.2.2",
    "@radix-ui/react-tooltip": "^1.1.3",
    "@radix-ui/react-avatar": "^1.1.1",
    "@radix-ui/react-checkbox": "^1.1.2",
    "@radix-ui/react-switch": "^1.1.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4",
    "tailwindcss-animate": "^1.0.7",
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
    "three": "^0.169.0",
    "aos": "^2.3.4"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "typescript": "^5.5.4",
    "@types/react": "19.0.0",
    "@types/react-dom": "19.0.0",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/bcryptjs": "^2.4.6",
    "@types/three": "^0.169.0"
  }
}`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

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
//  - resolve.alias @: maps to ./src so shadcn/ui @/components/ui/* imports work.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
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
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
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

const APP_TSX = `import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryClient'

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    </QueryClientProvider>
  )
}`

const STYLES_CSS = `@import "tailwindcss";

@layer base {
  :root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.205 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --accent: oklch(0.97 0 0);
    --accent-foreground: oklch(0.205 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --radius: 0.625rem;
  }
  .dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --primary: oklch(0.985 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
  }
}

@layer base {
  * { @apply border-border; box-sizing: border-box; }
  body {
    @apply bg-background text-foreground;
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
  }
}`

const UTILS_TS = `import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}`

const QUERY_CLIENT_TS = `import { QueryClient } from "@tanstack/react-query"
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60 * 1000, retry: 1 },
  },
})`

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
  writeFile('/home/user/app/src/lib/utils.ts', UTILS_TS),
  writeFile('/home/user/app/src/lib/queryClient.ts', QUERY_CLIENT_TS),
  // Install once at build time so per-project cold start is just a fast
  // `npm install` of whatever extra deps the generated app declares.
  // --legacy-peer-deps: React 19 conflicts with peer deps on some packages
  // (three.js ecosystem, particles, spline) that still declare react ^18.
  'RUN npm install --legacy-peer-deps',
].join('\n')

export const template = Template().fromDockerfile(dockerfile)
