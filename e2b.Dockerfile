FROM e2bdev/code-interpreter:latest

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# ── Global tooling ────────────────────────────────────────────────────────────
RUN npm install -g typescript vite tsx

WORKDIR /home/user/app

# ── Pre-cache dependencies ────────────────────────────────────────────────────
RUN cat <<'EOF' > /home/user/app/package.json
{
  "name": "lampcode-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@supabase/supabase-js": "^2.45.4",
    "lucide-react": "^0.439.0",
    "react-router-dom": "^6.26.2",
    "zod": "^3.23.8",
    "hono": "^4.6.3",
    "@hono/node-server": "^1.13.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "tailwindcss": "^3.4.10",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.45",
    "typescript": "^5.6.2",
    "vite": "^5.4.5"
  }
}
EOF
RUN npm install

# ── Vite config ───────────────────────────────────────────────────────────────
RUN cat <<'EOF' > /home/user/app/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
})
EOF

# ── index.html ────────────────────────────────────────────────────────────────
RUN cat <<'EOF' > /home/user/app/index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

# ── src/App.tsx ───────────────────────────────────────────────────────────────
RUN mkdir -p /home/user/app/src && cat <<'EOF' > /home/user/app/src/App.tsx
function App() {
  return (
    <div>
      <h1>Hello, world!</h1>
    </div>
  )
}

export default App
EOF

# ── src/main.tsx ──────────────────────────────────────────────────────────────
RUN cat <<'EOF' > /home/user/app/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
EOF

# ── .env ──────────────────────────────────────────────────────────────────────
RUN touch /home/user/app/.env

EXPOSE 5173

