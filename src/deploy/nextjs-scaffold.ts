import {
  PREBAKED_UI_PRIMITIVES,
  STYLES_CSS,
  UTILS_TS,
} from "./shared-scaffold-assets.js"

const NEXT_VERSION = "16.4.6"
const REACT_VERSION = "19.2.0"

const NEXT_DEPENDENCIES: Record<string, string> = {
  next: NEXT_VERSION,
  react: REACT_VERSION,
  "react-dom": REACT_VERSION,
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
  clsx: "^2.1.1",
  "tailwind-merge": "^2.5.4",
  "@supabase/supabase-js": "^2.45.0",
  "@supabase/ssr": "^0.5.1",
  mongoose: "^8.7.0",
  jsonwebtoken: "^9.0.2",
  bcryptjs: "^2.4.3",
  zod: "^3.23.8",
}

const NEXT_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: "^5.5.4",
  "@types/node": "^22.5.4",
  "@types/react": "^19.2.0",
  "@types/react-dom": "^19.2.0",
  "@types/jsonwebtoken": "^9.0.6",
  "@types/bcryptjs": "^2.4.6",
  tailwindcss: "^4.0.0",
  "@tailwindcss/postcss": "^4.0.0",
  postcss: "^8.4.0",
}

const NEXT_QUERY_CLIENT = `import { QueryClient } from "@tanstack/react-query"

// Keep the cache scoped to the rendered app tree, not a process-wide singleton.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 60 * 1000, retry: 1 } },
  })
}
`

const NEXT_PROVIDERS = `"use client"

import { useState } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { createQueryClient } from "@/lib/queryClient"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient())
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
`

const NEXT_LAYOUT = `import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "./providers"

export const metadata: Metadata = {
  title: "App",
  description: "Generated with LampCode",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><Providers>{children}</Providers></body>
    </html>
  )
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
}
`

const NEXT_CONFIG = `import type { NextConfig } from "next"

const nextConfig: NextConfig = {}
export default nextConfig
`

const NEXT_POSTCSS = `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}
export default config
`

const NEXT_ENV = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`

function declaredDependencies(files: Record<string, string>, key: "dependencies" | "devDependencies"): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(files["package.json"] ?? "{}")
    if (typeof parsed !== "object" || parsed === null) return {}
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch {
    return {}
  }
}

function has(files: Record<string, string>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, path)
}

function hasAny(files: Record<string, string>, paths: string[]): boolean {
  return paths.some(path => has(files, path))
}

/**
 * Build a complete Vercel source snapshot from a Next template-backed project.
 * Template-owned config/utilities are not stored with model-authored files, so
 * they must be materialized here just as the Vite deploy scaffold does.
 */
export function nextjsVercelScaffold(files: Record<string, string>): Record<string, string> {
  const hasSrcApp = Object.keys(files).some(path => path.startsWith("src/app/"))
  const hasRootApp = Object.keys(files).some(path => path.startsWith("app/"))
  if (hasSrcApp && hasRootApp) {
    throw new Error("This Next.js project contains both app/ and src/app/. Keep one App Router directory before deploying.")
  }
  const appDir = hasSrcApp ? "src/app" : "app"
  const pkg = {
    name: "lampcode-nextjs-app",
    private: true,
    type: "module",
    scripts: { build: "next build" },
    dependencies: { ...NEXT_DEPENDENCIES, ...declaredDependencies(files, "dependencies") },
    devDependencies: { ...NEXT_DEV_DEPENDENCIES, ...declaredDependencies(files, "devDependencies") },
  }

  const output: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
  }

  // Files that exist only inside the E2B image are reconstructed for Vercel.
  for (const [path, content] of [
    ["next.config.ts", NEXT_CONFIG],
    ["tsconfig.json", NEXT_TSCONFIG],
    ["postcss.config.mjs", NEXT_POSTCSS],
    ["next-env.d.ts", NEXT_ENV],
    [`${appDir}/providers.tsx`, NEXT_PROVIDERS],
    ["lib/queryClient.ts", NEXT_QUERY_CLIENT],
    ["lib/utils.ts", UTILS_TS],
    [`${appDir}/globals.css`, STYLES_CSS],
  ] as const) {
    if (!has(files, path)) output[path] = content
  }

  const pagePaths = [`${appDir}/page.tsx`, `${appDir}/page.jsx`, `${appDir}/page.js`]
  if (!hasAny(files, pagePaths)) output[`${appDir}/page.tsx`] = NEXT_PAGE
  const layoutPaths = [`${appDir}/layout.tsx`, `${appDir}/layout.jsx`, `${appDir}/layout.js`]
  if (!hasAny(files, layoutPaths)) output[`${appDir}/layout.tsx`] = NEXT_LAYOUT

  // The template pre-bakes shadcn-style primitives; generated pages may import
  // them without ever writing them into the project file snapshot.
  for (const [relativePath, content] of Object.entries(PREBAKED_UI_PRIMITIVES)) {
    if (!has(files, relativePath)) output[relativePath] = content
  }

  return output
}

/** Route probes are only enabled when the generated app actually has them. */
export function nextjsSmokeTargets(files: Record<string, string>): { checkHealth: boolean; checkAuth: boolean } {
  return {
    checkHealth: hasAny(files, ["app/api/health/route.ts", "src/app/api/health/route.ts"]),
    checkAuth: hasAny(files, ["app/api/auth/login/route.ts", "src/app/api/auth/login/route.ts"]),
  }
}
