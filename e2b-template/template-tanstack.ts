import { Template } from 'e2b'

// ── Lampcode preview sandbox — TanStack Start template ────────────────────────
// Bakes TanStack Start + vinxi baseline into the image, pre-installs deps.
// Dev server: `vinxi dev --port 3000 --host 0.0.0.0` (via npm run dev)
// The backend starts this command; NO CMD is set here to avoid race conditions.

const PKG_JSON = `{
  "name": "lampcode-tanstack-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vinxi dev --port 3000 --host 0.0.0.0",
    "build": "vinxi build",
    "start": "vinxi start"
  },
  "dependencies": {
    "@tanstack/start": "^1.81.5",
    "@tanstack/react-router": "^1.81.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@supabase/supabase-js": "^2.45.0",
    "mongoose": "^8.7.0",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vite": "^5.4.10",
    "vinxi": "^0.4.3",
    "typescript": "^5.5.4",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@types/node": "^22.5.4",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/bcryptjs": "^2.4.6"
  }
}`

const APP_CONFIG = `import { defineConfig } from '@tanstack/start/config'
export default defineConfig({
  react: {},
  server: { port: 3000 },
})`

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["app/**/*", "*.ts"]
}`

const ROOT_ROUTE = `import { createRootRoute, Outlet } from '@tanstack/react-router'
import '../globals.css'
export const Route = createRootRoute({
  component: () => <Outlet />,
})`

const INDEX_ROUTE = `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/')({
  component: () => (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>Loading…</main>
  ),
})`

const CLIENT_TSX = `import { StartClient } from '@tanstack/start'
import { createRouter } from './router'
import { hydrateRoot } from 'react-dom/client'
hydrateRoot(document, <StartClient router={createRouter()} />)`

const ROUTER_TSX = `import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
export function createRouter() {
  return createTanStackRouter({ routeTree })
}`

const GLOBALS_CSS = `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }`

const writeFile = (path: string, body: string): string => {
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  return `RUN mkdir -p "$(dirname ${path})" && echo '${b64}' | base64 -d > ${path}`
}

const dockerfile = [
  'FROM node:20-slim',
  'RUN apt-get update && apt-get install -y git curl ca-certificates && rm -rf /var/lib/apt/lists/*',
  'WORKDIR /home/user/app',
  writeFile('/home/user/app/package.json', PKG_JSON),
  writeFile('/home/user/app/app.config.ts', APP_CONFIG),
  writeFile('/home/user/app/tsconfig.json', TSCONFIG),
  writeFile('/home/user/app/app/routes/__root.tsx', ROOT_ROUTE),
  writeFile('/home/user/app/app/routes/index.tsx', INDEX_ROUTE),
  writeFile('/home/user/app/app/client.tsx', CLIENT_TSX),
  writeFile('/home/user/app/app/router.tsx', ROUTER_TSX),
  writeFile('/home/user/app/app/globals.css', GLOBALS_CSS),
  'RUN npm install',
  // Warm vinxi dev\'s initial build cache so sandbox first-start is fast.
  // Starts vinxi dev in the background, waits 20 s for initial compilation, then kills it.
  // Warm vinxi dev cache: start server, wait for boot, hit / to trigger route compilation, then kill.
  'RUN npx vinxi dev --port 3000 --host 0.0.0.0 & PID=$!; sleep 8; curl -sf http://localhost:3000/ > /dev/null || true; sleep 5; kill $PID 2>/dev/null; wait $PID 2>/dev/null || true',
].join('\n')

export const template = Template().fromDockerfile(dockerfile)
