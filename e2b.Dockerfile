FROM e2bdev/code-interpreter:latest

WORKDIR /home/user/app

RUN npm install -g typescript vite tsx

RUN npm init -y && \
    npm pkg set type="module" && \
    npm pkg set scripts.dev="vite" && \
    npm install react react-dom @supabase/supabase-js lucide-react react-router-dom && \
    npm install -D @types/react @types/react-dom @vitejs/plugin-react tailwindcss typescript vite

COPY <<'EOF' vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, allowedHosts: true }
})
EOF

COPY <<'EOF' index.html
<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>App</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

RUN mkdir -p src

COPY <<'EOF' src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
EOF

COPY <<'EOF' src/App.tsx
export default function App() {
  return <div>Ready</div>
}
EOF

EXPOSE 5173
