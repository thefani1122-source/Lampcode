import { createUbuntuBaseTemplate, PREBAKED_UI_PRIMITIVES, STYLES_CSS, UTILS_TS, QUERY_CLIENT_TS, writeFileCommand } from './template.js'

// Next.js App Router candidate built on the shared Ubuntu 24.04 runtime.
// No start/ready command is baked in: e2b-service owns process lifecycle,
// readiness, framework-specific ports, and the independent verification loop.

export const NEXTJS_VERSION = '16.4.6'
export const NEXTJS_REACT_VERSION = '19.2.0'

export const NEXTJS_PKG_JSON = JSON.stringify({
  name: 'lampcode-nextjs-app',
  private: true,
  scripts: {
    dev: 'next dev --port 3000 --hostname 0.0.0.0',
    build: 'next build',
    start: 'next start --port 3000 --hostname 0.0.0.0',
    test: 'vitest run',
    typecheck: 'tsc --noEmit',
  },
  dependencies: {
    next: NEXTJS_VERSION,
    react: NEXTJS_REACT_VERSION,
    'react-dom': NEXTJS_REACT_VERSION,
    '@tanstack/react-query': '^5.62.0',
    'lucide-react': '^0.460.0',
    '@radix-ui/react-dialog': '^1.1.2',
    '@radix-ui/react-dropdown-menu': '^2.1.2',
    '@radix-ui/react-label': '^2.1.0',
    '@radix-ui/react-select': '^2.1.2',
    '@radix-ui/react-separator': '^1.1.0',
    '@radix-ui/react-slot': '^1.1.0',
    '@radix-ui/react-tabs': '^1.1.1',
    '@radix-ui/react-toast': '^1.2.2',
    '@radix-ui/react-tooltip': '^1.1.3',
    '@radix-ui/react-avatar': '^1.1.1',
    '@radix-ui/react-checkbox': '^1.1.2',
    '@radix-ui/react-switch': '^1.1.1',
    'class-variance-authority': '^0.7.1',
    clsx: '^2.1.1',
    'tailwind-merge': '^2.5.4',
    '@supabase/supabase-js': '^2.45.0',
    '@supabase/ssr': '^0.5.1',
    mongoose: '^8.7.0',
    zod: '^3.23.8',
  },
  devDependencies: {
    typescript: '^5.5.4',
    '@types/node': '^22.5.4',
    '@types/react': '^19.2.0',
    '@types/react-dom': '^19.2.0',
    tailwindcss: '^4.0.0',
    '@tailwindcss/postcss': '^4.0.0',
    postcss: '^8.4.0',
    vitest: '^2.1.8',
    jsdom: '^25.0.1',
    '@testing-library/react': '^16.1.0',
    '@testing-library/dom': '^10.4.0',
    '@testing-library/jest-dom': '^6.6.3',
    '@vitejs/plugin-react': '^4.3.1',
    vite: '^6.0.0',
  },
}, null, 2)

const NEXT_CONFIG = `import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Next handles the dependency bundle. Add a package here only when its
  // docs explicitly require transpilation in a server component.
}

export default nextConfig
`

const NEXT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}`

const POSTCSS_CONFIG = `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
export default config
`

const NEXT_LAYOUT = `import type { Metadata } from 'next'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'App',
  description: 'Generated with LampCode',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
`

const NEXT_PROVIDERS = `'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryClient'

export function Providers({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
`

const NEXT_PAGE = `export default function Page() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">Loading your application…</p>
      </div>
    </main>
  )
}
`

const NEXT_VITEST_CONFIG = `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    css: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
`

const NEXT_VITEST_SETUP = `import '@testing-library/jest-dom/vitest'`

export const NEXTJS_SCAFFOLD_COMMANDS = [
  writeFileCommand('/home/user/app/package.json', NEXTJS_PKG_JSON),
  writeFileCommand('/home/user/app/next.config.ts', NEXT_CONFIG),
  writeFileCommand('/home/user/app/tsconfig.json', NEXT_TSCONFIG),
  writeFileCommand('/home/user/app/postcss.config.mjs', POSTCSS_CONFIG),
  writeFileCommand('/home/user/app/app/layout.tsx', NEXT_LAYOUT),
  writeFileCommand('/home/user/app/app/providers.tsx', NEXT_PROVIDERS),
  writeFileCommand('/home/user/app/app/page.tsx', NEXT_PAGE),
  writeFileCommand('/home/user/app/app/globals.css', STYLES_CSS),
  writeFileCommand('/home/user/app/vitest.config.ts', NEXT_VITEST_CONFIG),
  writeFileCommand('/home/user/app/vitest.setup.ts', NEXT_VITEST_SETUP),
  ...Object.entries(PREBAKED_UI_PRIMITIVES).map(([filePath, fileContent]) =>
    writeFileCommand(`/home/user/app/${filePath}`, fileContent),
  ),
  writeFileCommand('/home/user/app/lib/utils.ts', UTILS_TS),
  writeFileCommand('/home/user/app/lib/queryClient.ts', QUERY_CLIENT_TS),
  'cd /home/user/app && npm install --legacy-peer-deps',
  'chown -R user:user /home/user/app',
]

export const ubuntuNextTemplate = createUbuntuBaseTemplate()
  .runCmd(NEXTJS_SCAFFOLD_COMMANDS, { user: 'root' })
  .setWorkdir('/home/user/app')
