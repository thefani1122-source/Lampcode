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
    "preview": "vite preview",
    "test": "vitest run"
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
    "@supabase/supabase-js": "^2.45.0",
    "ws": "^8.18.0",
    "react-router-dom": "^6.28.0",
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
    "vitest": "^2.1.8",
    "jsdom": "^25.0.1",
    "@testing-library/react": "^16.1.0",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.6.3",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "typescript": "^5.5.4",
    "@types/ws": "^8.5.13",
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

// vitest.setup.ts is in `include` even though it sits outside src/. Its only
// statement imports jest-dom's type augmentation, and that augmentation has to
// be part of the SAME TypeScript program as the test files or `tsc --noEmit`
// reports toBeInTheDocument() as a non-existent matcher on a test that passes
// perfectly well at runtime — check_types failing on correct code.
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
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vitest.setup.ts"]
}`

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <style>
      /* Vite's error overlay, kept in the DOM and taken off the screen.
       *
       * It must STAY in the DOM. check_page detects a module-resolution
       * failure by querying \`vite-error-overlay\` and reading its shadow root,
       * and the comment there records why: such a failure never reaches the
       * console as an error, so that element is the only evidence there is.
       * Measured 2026-10-04 — three builds shipped behind a full-screen
       * "Failed to resolve import" while the agent reported the page fine.
       * \`server.hmr.overlay: false\` would remove the element and blind the
       * strongest page check in the product to fix a cosmetic problem.
       *
       * So it is hidden, not disabled. \`display: none\` leaves
       * querySelector and textContent working exactly as before while the
       * person sees their app instead of a wall of stack traces, and
       * Lampcode tells them what is wrong in its own words. Measured
       * 2026-10-18 — a person watching a build met a red overlay about
       * "./pages/HomePage" next to a message saying the app was complete.
       */
      vite-error-overlay { display: none !important; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>`

// Ambient declarations for non-code imports. index.tsx below does
// `import './styles.css'`, which TypeScript reports as TS2882 without these.
// Kept in sync with VITE_ENV_DTS in src/preview/e2b-service.ts, which writes
// the same file at runtime so existing sandboxes don't need a rebuild.
const VITE_ENV_DTS = `/// <reference types="vite/client" />
declare module '*.css';
declare module '*.scss';
declare module '*.sass';
declare module '*.less';
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.gif';
declare module '*.webp';
declare module '*.avif';
declare module '*.woff';
declare module '*.woff2';
`

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
@custom-variant dark (&:where(.dark, .dark *));
:root {
  --background: oklch(0.985 0.002 247);
  --foreground: oklch(0.145 0.015 250);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0.015 250);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0.015 250);
  --primary: oklch(0.50 0.20 264);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.96 0.01 250);
  --secondary-foreground: oklch(0.25 0.02 250);
  --muted: oklch(0.96 0.008 250);
  --muted-foreground: oklch(0.50 0.02 250);
  --accent: oklch(0.95 0.03 264);
  --accent-foreground: oklch(0.35 0.18 264);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.915 0.008 250);
  --input: oklch(0.915 0.008 250);
  --ring: oklch(0.50 0.20 264);
  --radius: 0.625rem;
}
.dark {
  --background: oklch(0.12 0.015 250);
  --foreground: oklch(0.985 0.002 247);
  --card: oklch(0.16 0.018 250);
  --card-foreground: oklch(0.985 0.002 247);
  --popover: oklch(0.16 0.018 250);
  --popover-foreground: oklch(0.985 0.002 247);
  --primary: oklch(0.65 0.22 264);
  --primary-foreground: oklch(0.12 0.015 250);
  --secondary: oklch(0.22 0.02 250);
  --secondary-foreground: oklch(0.985 0.002 247);
  --muted: oklch(0.20 0.02 250);
  --muted-foreground: oklch(0.65 0.02 250);
  --accent: oklch(0.24 0.03 264);
  --accent-foreground: oklch(0.985 0.002 247);
  --destructive: oklch(0.55 0.22 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.65 0.22 264);
}
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
@layer base {
  * { @apply border-border; box-sizing: border-box; }
  body {
    @apply bg-background text-foreground;
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
  }
}`

const PREBAKED_UI_PRIMITIVES: Record<string, string> = {"components/ui/avatar.tsx": "import * as React from 'react'\nimport * as AvatarPrimitive from '@radix-ui/react-avatar'\nimport { cn } from '@/lib/utils'\n\nconst Avatar = React.forwardRef<\n  React.ElementRef<typeof AvatarPrimitive.Root>,\n  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>\n>(({ className, ...props }, ref) => (\n  <AvatarPrimitive.Root\n    ref={ref}\n    className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full', className)}\n    {...props}\n  />\n))\nAvatar.displayName = AvatarPrimitive.Root.displayName\n\nconst AvatarImage = React.forwardRef<\n  React.ElementRef<typeof AvatarPrimitive.Image>,\n  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>\n>(({ className, ...props }, ref) => (\n  <AvatarPrimitive.Image\n    ref={ref}\n    className={cn('aspect-square h-full w-full', className)}\n    {...props}\n  />\n))\nAvatarImage.displayName = AvatarPrimitive.Image.displayName\n\nconst AvatarFallback = React.forwardRef<\n  React.ElementRef<typeof AvatarPrimitive.Fallback>,\n  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>\n>(({ className, ...props }, ref) => (\n  <AvatarPrimitive.Fallback\n    ref={ref}\n    className={cn(\n      'flex h-full w-full items-center justify-center rounded-full bg-muted font-medium text-xs',\n      className\n    )}\n    {...props}\n  />\n))\nAvatarFallback.displayName = AvatarPrimitive.Fallback.displayName\n\nexport { Avatar, AvatarImage, AvatarFallback }\n", "components/ui/badge.tsx": "import * as React from 'react'\nimport { cva, type VariantProps } from 'class-variance-authority'\nimport { cn } from '@/lib/utils'\n\nconst badgeVariants = cva(\n  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',\n  {\n    variants: {\n      variant: {\n        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',\n        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',\n        destructive: 'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',\n        outline: 'text-foreground',\n        success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',\n      },\n    },\n    defaultVariants: {\n      variant: 'default',\n    },\n  }\n)\n\nexport interface BadgeProps\n  extends React.HTMLAttributes<HTMLDivElement>,\n    VariantProps<typeof badgeVariants> {}\n\nfunction Badge({ className, variant, ...props }: BadgeProps) {\n  return <div className={cn(badgeVariants({ variant }), className)} {...props} />\n}\n\nexport { Badge, badgeVariants }\n", "components/ui/button.tsx": "import * as React from 'react'\nimport { Slot } from '@radix-ui/react-slot'\nimport { cva, type VariantProps } from 'class-variance-authority'\nimport { cn } from '@/lib/utils'\n\nconst buttonVariants = cva(\n  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',\n  {\n    variants: {\n      variant: {\n        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',\n        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',\n        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',\n        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',\n        ghost: 'hover:bg-accent hover:text-accent-foreground',\n        link: 'text-primary underline-offset-4 hover:underline',\n      },\n      size: {\n        default: 'h-9 px-4 py-2',\n        sm: 'h-8 rounded-md px-3 text-xs',\n        lg: 'h-10 rounded-md px-8',\n        icon: 'h-9 w-9',\n      },\n    },\n    defaultVariants: {\n      variant: 'default',\n      size: 'default',\n    },\n  }\n)\n\nexport interface ButtonProps\n  extends React.ButtonHTMLAttributes<HTMLButtonElement>,\n    VariantProps<typeof buttonVariants> {\n  asChild?: boolean\n}\n\nconst Button = React.forwardRef<HTMLButtonElement, ButtonProps>(\n  ({ className, variant, size, asChild = false, ...props }, ref) => {\n    const Comp = asChild ? Slot : 'button'\n    return (\n      <Comp\n        className={cn(buttonVariants({ variant, size, className }))}\n        ref={ref}\n        {...props}\n      />\n    )\n  }\n)\nButton.displayName = 'Button'\n\nexport { Button, buttonVariants }\n", "components/ui/card.tsx": "import * as React from 'react'\nimport { cn } from '@/lib/utils'\n\nconst Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(\n  ({ className, ...props }, ref) => (\n    <div\n      ref={ref}\n      className={cn('rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm', className)}\n      {...props}\n    />\n  )\n)\nCard.displayName = 'Card'\n\nconst CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(\n  ({ className, ...props }, ref) => (\n    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />\n  )\n)\nCardHeader.displayName = 'CardHeader'\n\nconst CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(\n  ({ className, ...props }, ref) => (\n    <h3 ref={ref} className={cn('font-semibold leading-none tracking-tight text-lg', className)} {...props} />\n  )\n)\nCardTitle.displayName = 'CardTitle'\n\nconst CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(\n  ({ className, ...props }, ref) => (\n    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />\n  )\n)\nCardDescription.displayName = 'CardDescription'\n\nconst CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(\n  ({ className, ...props }, ref) => (\n    <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />\n  )\n)\nCardContent.displayName = 'CardContent'\n\nconst CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(\n  ({ className, ...props }, ref) => (\n    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />\n  )\n)\nCardFooter.displayName = 'CardFooter'\n\nexport { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }\n", "components/ui/dialog.tsx": "import * as React from 'react'\nimport * as DialogPrimitive from '@radix-ui/react-dialog'\nimport { X } from 'lucide-react'\nimport { cn } from '@/lib/utils'\n\nconst Dialog = DialogPrimitive.Root\nconst DialogTrigger = DialogPrimitive.Trigger\nconst DialogPortal = DialogPrimitive.Portal\nconst DialogClose = DialogPrimitive.Close\n\nconst DialogOverlay = React.forwardRef<\n  React.ElementRef<typeof DialogPrimitive.Overlay>,\n  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>\n>(({ className, ...props }, ref) => (\n  <DialogPrimitive.Overlay\n    ref={ref}\n    className={cn(\n      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',\n      className\n    )}\n    {...props}\n  />\n))\nDialogOverlay.displayName = DialogPrimitive.Overlay.displayName\n\nconst DialogContent = React.forwardRef<\n  React.ElementRef<typeof DialogPrimitive.Content>,\n  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>\n>(({ className, children, ...props }, ref) => (\n  <DialogPortal>\n    <DialogOverlay />\n    <DialogPrimitive.Content\n      ref={ref}\n      className={cn(\n        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',\n        className\n      )}\n      {...props}\n    >\n      {children}\n      <DialogPrimitive.Close className=\"absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground\">\n        <X className=\"h-4 w-4\" />\n        <span className=\"sr-only\">Close</span>\n      </DialogPrimitive.Close>\n    </DialogPrimitive.Content>\n  </DialogPortal>\n))\nDialogContent.displayName = DialogPrimitive.Content.displayName\n\nconst DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (\n  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />\n)\nDialogHeader.displayName = 'DialogHeader'\n\nconst DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (\n  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />\n)\nDialogFooter.displayName = 'DialogFooter'\n\nconst DialogTitle = React.forwardRef<\n  React.ElementRef<typeof DialogPrimitive.Title>,\n  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>\n>(({ className, ...props }, ref) => (\n  <DialogPrimitive.Title\n    ref={ref}\n    className={cn('text-lg font-semibold leading-none tracking-tight', className)}\n    {...props}\n  />\n))\nDialogTitle.displayName = DialogPrimitive.Title.displayName\n\nconst DialogDescription = React.forwardRef<\n  React.ElementRef<typeof DialogPrimitive.Description>,\n  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>\n>(({ className, ...props }, ref) => (\n  <DialogPrimitive.Description\n    ref={ref}\n    className={cn('text-sm text-muted-foreground', className)}\n    {...props}\n  />\n))\nDialogDescription.displayName = DialogPrimitive.Description.displayName\n\nexport {\n  Dialog,\n  DialogPortal,\n  DialogOverlay,\n  DialogTrigger,\n  DialogClose,\n  DialogContent,\n  DialogHeader,\n  DialogFooter,\n  DialogTitle,\n  DialogDescription,\n}\n", "components/ui/input.tsx": "import * as React from 'react'\nimport { cn } from '@/lib/utils'\n\nconst Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(\n  ({ className, type, ...props }, ref) => {\n    return (\n      <input\n        type={type}\n        className={cn(\n          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',\n          className\n        )}\n        ref={ref}\n        {...props}\n      />\n    )\n  }\n)\nInput.displayName = 'Input'\n\nexport { Input }\n", "components/ui/separator.tsx": "import * as React from 'react'\nimport * as SeparatorPrimitive from '@radix-ui/react-separator'\nimport { cn } from '@/lib/utils'\n\nconst Separator = React.forwardRef<\n  React.ElementRef<typeof SeparatorPrimitive.Root>,\n  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>\n>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (\n  <SeparatorPrimitive.Root\n    ref={ref}\n    decorative={decorative}\n    orientation={orientation}\n    className={cn(\n      'shrink-0 bg-border',\n      orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',\n      className\n    )}\n    {...props}\n  />\n))\nSeparator.displayName = SeparatorPrimitive.Root.displayName\n\nexport { Separator }\n", "components/ui/table.tsx": "import * as React from 'react'\nimport { cn } from '@/lib/utils'\n\nconst Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(\n  ({ className, ...props }, ref) => (\n    <div className=\"relative w-full overflow-auto\">\n      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />\n    </div>\n  )\n)\nTable.displayName = 'Table'\n\nconst TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(\n  ({ className, ...props }, ref) => <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />\n)\nTableHeader.displayName = 'TableHeader'\n\nconst TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(\n  ({ className, ...props }, ref) => (\n    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />\n  )\n)\nTableBody.displayName = 'TableBody'\n\nconst TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(\n  ({ className, ...props }, ref) => (\n    <tfoot ref={ref} className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} />\n  )\n)\nTableFooter.displayName = 'TableFooter'\n\nconst TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(\n  ({ className, ...props }, ref) => (\n    <tr\n      ref={ref}\n      className={cn(\n        'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',\n        className\n      )}\n      {...props}\n    />\n  )\n)\nTableRow.displayName = 'TableRow'\n\nconst TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(\n  ({ className, ...props }, ref) => (\n    <th\n      ref={ref}\n      className={cn(\n        'h-10 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0',\n        className\n      )}\n      {...props}\n    />\n  )\n)\nTableHead.displayName = 'TableHead'\n\nconst TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(\n  ({ className, ...props }, ref) => (\n    <td ref={ref} className={cn('p-4 align-middle [&:has([role=checkbox])]:pr-0', className)} {...props} />\n  )\n)\nTableCell.displayName = 'TableCell'\n\nconst TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(\n  ({ className, ...props }, ref) => (\n    <caption ref={ref} className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />\n  )\n)\nTableCaption.displayName = 'TableCaption'\n\nexport {\n  Table,\n  TableHeader,\n  TableBody,\n  TableFooter,\n  TableHead,\n  TableRow,\n  TableCell,\n  TableCaption,\n}\n", "components/ui/tabs.tsx": "import * as React from 'react'\nimport * as TabsPrimitive from '@radix-ui/react-tabs'\nimport { cn } from '@/lib/utils'\n\nconst Tabs = TabsPrimitive.Root\n\nconst TabsList = React.forwardRef<\n  React.ElementRef<typeof TabsPrimitive.List>,\n  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>\n>(({ className, ...props }, ref) => (\n  <TabsPrimitive.List\n    ref={ref}\n    className={cn(\n      'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',\n      className\n    )}\n    {...props}\n  />\n))\nTabsList.displayName = TabsPrimitive.List.displayName\n\nconst TabsTrigger = React.forwardRef<\n  React.ElementRef<typeof TabsPrimitive.Trigger>,\n  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>\n>(({ className, ...props }, ref) => (\n  <TabsPrimitive.Trigger\n    ref={ref}\n    className={cn(\n      'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow',\n      className\n    )}\n    {...props}\n  />\n))\nTabsTrigger.displayName = TabsPrimitive.Trigger.displayName\n\nconst TabsContent = React.forwardRef<\n  React.ElementRef<typeof TabsPrimitive.Content>,\n  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>\n>(({ className, ...props }, ref) => (\n  <TabsPrimitive.Content\n    ref={ref}\n    className={cn(\n      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',\n      className\n    )}\n    {...props}\n  />\n))\nTabsContent.displayName = TabsPrimitive.Content.displayName\n\nexport { Tabs, TabsList, TabsTrigger, TabsContent }\n"};

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

// Headless-Chromium render check (build.ts's finishPreview(), after the
// backend-crash and typecheck fix loops) — navigates to the live Vite dev
// server INSIDE the sandbox (never the external URL) and reports console
// errors / an empty #root as a single JSON line on stdout. Kept as a static
// file baked into the image (like the scaffold files below) rather than
// written per-build, since its content never depends on the generated app.
const CHECK_RENDER_MJS = `import { chromium } from "playwright"

const url = process.argv[2] || "http://localhost:5173"
const errors = []
let result

try {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()) })
  page.on("pageerror", (err) => errors.push(String(err)))
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 })
    await page.waitForTimeout(500) // let async errors surface after load
    const rootHasChildren = await page.evaluate(() => {
      const root = document.getElementById("root")
      return !!root && root.children.length > 0
    })
    // Vite's error overlay is a CUSTOM ELEMENT appended to document.body, not
    // a child of #root, and a module-resolution failure never reaches the
    // console as an error — so neither of the two checks above can see it.
    // Measured 2026-10-04: three builds shipped with a full-screen
    // "Failed to resolve import" overlay while the agent reported the page
    // rendering without errors. Reading its own message text matters as much
    // as detecting it: that is the one string that says what to fix.
    const overlay = await page.evaluate(() => {
      const el = document.querySelector("vite-error-overlay")
      if (!el) return null
      const text = (el.shadowRoot ? el.shadowRoot.textContent : el.textContent) || ""
      return text.replace(/\\s+/g, " ").trim().slice(0, 500)
    })
    if (overlay) errors.push("Vite error overlay: " + overlay)
    result = {
      ok: errors.length === 0 && rootHasChildren && !overlay,
      blank: !rootHasChildren,
      overlay: overlay || undefined,
      errors,
    }
  } finally {
    await browser.close()
  }
} catch (err) {
  result = { ok: false, blank: true, errors: [String(err)] }
}

console.log(JSON.stringify(result))
`

// Vitest gets its OWN config rather than a `test` key inside vite.config.ts.
// vite.config.ts is the most load-bearing file in the image — if its imports
// ever fail the dev server never starts and every build dies — and importing
// `vitest/config` there would hang that on a devDependency. Here, a broken
// import costs only the tests.
//
// Plugins and the @ alias are repeated because a separate vitest.config.ts
// REPLACES vite.config.ts rather than extending it; without the react plugin,
// every .tsx test fails on the first JSX token. tailwindcss is deliberately
// left out (tests don't render CSS) along with `css: false`, which keeps a
// component's stylesheet import from being compiled on every run.
//
// No passWithNoTests: a run with no test files must exit non-zero, because
// "the agent wrote no tests" and "the tests pass" are different facts and
// runTests in e2b-service.ts reports them differently.
const VITEST_CONFIG = `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    // Each file gets its own process group; a test that hangs on a timer
    // cannot then hold the whole run open past the tool's timeout.
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})`

// jest-dom's matchers (toBeInTheDocument, toHaveTextContent, …). Registered
// here because models reach for them by habit, and without the import they
// fail as "not a function", which reads like a broken test rather than a
// missing matcher.
const VITEST_SETUP = `import '@testing-library/jest-dom/vitest'`

// Minimal manifest for the internal tooling directory — see the note beside
// the WORKDIR below for why this is not `npm init -y`.
const TOOLS_PKG_JSON = JSON.stringify(
  { name: 'lampcode-tools', version: '1.0.0', private: true },
  null,
  2,
)

const dockerfile = [
  'FROM node:20-slim',
  'RUN apt-get update && apt-get install -y git curl ca-certificates python3 python3-pip && rm -rf /var/lib/apt/lists/*',
  'RUN npm install -g vite tsx typescript',
  // Python backends (FastAPI) run on the same :3001 the frontend proxies /api to.
  'RUN pip3 install --no-cache-dir --break-system-packages fastapi "uvicorn[standard]" supabase python-dotenv crewai langgraph langchain-anthropic apscheduler exa-py pandas numpy scikit-learn',
  'WORKDIR /home/user/app',
  writeFile('/home/user/app/package.json', PKG_JSON),
  writeFile('/home/user/app/vite.config.ts', VITE_CONFIG),
  writeFile('/home/user/app/vitest.config.ts', VITEST_CONFIG),
  writeFile('/home/user/app/vitest.setup.ts', VITEST_SETUP),
  writeFile('/home/user/app/tsconfig.json', TSCONFIG),
  writeFile('/home/user/app/index.html', INDEX_HTML),
  writeFile('/home/user/app/src/index.tsx', INDEX_TSX),
  writeFile('/home/user/app/src/vite-env.d.ts', VITE_ENV_DTS),
  writeFile('/home/user/app/src/App.tsx', APP_TSX),
  writeFile('/home/user/app/src/styles.css', STYLES_CSS),
  ...Object.entries(PREBAKED_UI_PRIMITIVES).map(([filePath, fileContent]) => writeFile(`/home/user/app/src/${filePath}`, fileContent)),
  writeFile('/home/user/app/src/lib/utils.ts', UTILS_TS),
  writeFile('/home/user/app/src/lib/queryClient.ts', QUERY_CLIENT_TS),
  // Install once at build time so per-project cold start is just a fast
  // `npm install` of whatever extra deps the generated app declares.
  // --legacy-peer-deps: React 19 conflicts with peer deps on some packages
  // (three.js ecosystem, particles, spline) that still declare react ^18.
  'RUN npm install --legacy-peer-deps',
  // Belt and braces, NOT load-bearing — do not reason from its presence.
  // The image is built as root but run as `user`, so everything above this line
  // is written root-owned, and vitest needs to write a transform cache under
  // node_modules. That looked like it needed fixing. It does not: E2B's own
  // `[config]` phase ends every build with "Give 'user' ownership to
  // /home/user", so ownership is already correct without this step — confirmed
  // in the 2026-10-02 build log and by a live sandbox writing into
  // node_modules. Kept because it costs one cached layer and states the
  // requirement explicitly where the next person will look for it.
  'RUN chown -R user:user /home/user/app',
  // ── Internal tooling, deliberately OUTSIDE /home/user/app ─────────────────
  // Headless Chromium for the post-build render check (verifyBrowserRender in
  // e2b-service.ts) — kept in its own directory with its own node_modules so
  // it never touches the generated app's package.json/dependency tree (that
  // list is what the build prompt tells the model is "allowed" — see CLAUDE.md's
  // "Prompt-vs-reality drift" warning). `playwright install --with-deps` pulls
  // the exact OS packages its bundled Chromium build needs for this Debian
  // base — baked here (build time) so per-project cold start never re-fetches
  // a browser.
  //
  // The package.json is written explicitly rather than generated with
  // `npm init -y`, which names the package after its directory. npm rejects a
  // name beginning with a dot, so in `.lampcode-tools` it exits with
  //   npm error Invalid name: ".lampcode-tools"
  // taking the whole && chain with it. That failed every template build since
  // this step was added on 2026-09-09 — so playwright and check-render.mjs
  // never reached the image, and check_page could never have worked.
  //
  // PLAYWRIGHT_BROWSERS_PATH is set because the image is BUILT as root but RUN
  // as `user`, and playwright resolves its browser directory from the running
  // user's home. Left at the default, chromium downloads into /root/.cache and
  // check_page dies at launch with "Executable doesn't exist at
  // /home/user/.cache/ms-playwright/..." — confirmed in a live sandbox, with
  // playwright and check-render.mjs both present and correct. The path is
  // repeated on the commands in e2b-service.ts, so this does not depend on
  // Docker ENV surviving into E2B's runtime.
  'WORKDIR /home/user/.lampcode-tools',
  writeFile('/home/user/.lampcode-tools/package.json', TOOLS_PKG_JSON),
  'ENV PLAYWRIGHT_BROWSERS_PATH=/home/user/.lampcode-tools/browsers',
  'RUN npm install playwright && npx playwright install --with-deps chromium ' +
    '&& chown -R user:user /home/user/.lampcode-tools',
  writeFile('/home/user/.lampcode-tools/check-render.mjs', CHECK_RENDER_MJS),
  'WORKDIR /home/user/app',
].join('\n')

export const template = Template().fromDockerfile(dockerfile)
