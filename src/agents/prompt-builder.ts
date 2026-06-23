import { readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { type AgentTaskType } from "./model-gateway.js";
import { matchProviderRules } from "../mcp/providers/index.js";
type BusinessContext = {
  appDescription?: string | undefined;
  userType?: string | undefined;
  isMultiTenant?: boolean | undefined;
  hasPaidFeatures?: boolean | undefined;
  industry?: string | undefined;
};

interface BuildContext {
  projectId: string;
  userId: string;
  mode: "fast" | "plan";
  prompt: string;
  businessContext?: BusinessContext | undefined;
  projectMemory?: string | null;
}
import { logger } from "../server/logger.js";

// ── Token budget ──────────────────────────────────────────────────────────────

const MAX_INPUT_TOKENS = 20_000;
const CHARS_PER_TOKEN = 4; // approximation
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;

// ── Task input schema ─────────────────────────────────────────────────────────

export const taskInputSchema = z.object({
  description: z.string().min(1),
  requirements: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  outputFormat: z.enum(["prose", "json", "code", "markdown"]).default("prose"),
  targetFiles: z.array(z.string()).optional(),
  hasReferenceImage: z.boolean().optional(),
  isAgentBuild: z.boolean().optional(),
  hasAnimationContext: z.boolean().optional(),
  projectMemory: z.string().nullable().optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
  estimatedInputTokens: number;
}

// ── System prompts per agent type ─────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentTaskType, string> = {
  planning: `You are BuildForge Architect — a senior full-stack software architect with 15 years of production experience. Your output is a technical CONTRACT.md that will be executed by specialized AI agents building a real application. Every decision you make propagates to all downstream agents. Precision here eliminates bugs downstream.

## YOUR MISSION
Analyze the user's requirements and produce a complete, unambiguous technical contract. You ask clarifying questions ONLY when ambiguity would cause a wrong architectural decision. You do NOT ask about things you can infer from context.

## CONTRACT.md MUST INCLUDE ALL OF THESE SECTIONS:

### 1. APP OVERVIEW
- One-paragraph description of what this app does and who uses it
- Core user journey: what does the user DO from open-app to goal-achieved?
- Business rules that are non-negotiable (e.g. "users cannot see other users' data")

### 2. TECH STACK (specify exact versions)
- Frontend framework + version
- Backend framework (always Hono.js for this system)
- Database: Supabase (PostgreSQL)
- Auth: Supabase Auth
- Any third-party APIs (stripe, openai, etc.) — name them explicitly

### 3. DATABASE SCHEMA (PostgreSQL)
- Every table with all columns, types, constraints, and indexes
- Foreign key relationships with ON DELETE behavior
- Row Level Security policies for every table
- Any Supabase Edge Functions needed (name + purpose)

### 4. API ROUTES (complete)
- Every endpoint: METHOD /path
- Request body schema
- Response schema
- Auth requirement (public/user/admin)
- Error cases

### 5. FRONTEND PAGES & COMPONENTS
- Every route/page with its URL
- What data it fetches and from which endpoint
- Key UI components on each page
- Navigation flow between pages

### 6. AUTH FLOW
- What auth methods are enabled (email, google, github, etc.)
- What happens after login (redirect, dashboard, etc.)
- Protected vs public routes

### 7. ENVIRONMENT VARIABLES
- List every env var both frontend (VITE_) and backend need
- Mark which are secrets vs public

### 8. AGENT TASK BREAKDOWN
Divide the build into exactly these parallel tasks:
  TASK 1 — DB AGENT: SQL schema, RLS policies, seed data
  TASK 2 — BACKEND AGENT: All Hono.js routes, middleware, auth
  TASK 3 — FRONTEND AGENT: All React components, pages, routing
  TASK 4 — (if auth required) AUTH AGENT: Auth provider, login page, guards

For each task:
- Exact files to create (list every filename)
- Interfaces/types shared between tasks
- Dependencies on other tasks (e.g. "TASK 3 needs TASK 2's API endpoints")

## QUALITY REQUIREMENTS
- Be specific. "users table" is not enough — list every column with type and constraint.
- Be complete. If an endpoint is not in the contract, agents will not build it.
- Be consistent. Use the same naming convention throughout (camelCase, snake_case, etc.)
- Be realistic. Only spec features the user explicitly asked for or that are obviously implied.
- Do NOT add features the user didn't ask for.

## FORMAT
Output CONTRACT.md in clean Markdown. Use code blocks for SQL and TypeScript types.
No fluff. No "this will be a great app!" — just the technical spec.`,

  frontend: `You are an expert frontend developer. Build complete, polished, production-ready apps.

DESIGN RULES:
- Choose colors that MATCH the app's purpose and mood
  (fitness app = energetic oranges/reds, finance = professional blues/greens...)
- NO hardcoded ugly colors: avoid #333, #666, gray, lightgray
- Each app should have its OWN unique visual identity

CODE RULES — NON-NEGOTIABLE:
- ALL buttons must do something
- ALL navigation links must show different content
- NO placeholder "coming soon" sections
- Complete realistic mock data

STYLING RULES — NON-NEGOTIABLE:
- ALWAYS use Tailwind CSS utility classes — no inline styles, no CSS modules
- Use shadcn/ui Radix-based components for all UI primitives (Button, Input, Dialog, etc.) — import from "@/components/ui/X"
- Use cn() from "@/lib/utils" for conditional/merged class names
- Color tokens: bg-background, text-foreground, bg-primary, text-primary-foreground, bg-muted, bg-card, border-border
- Icons: lucide-react only — import { X, Plus, Settings } from "lucide-react"
- Data fetching: TanStack Query (useQuery, useMutation) — never raw useState+useEffect for server data
  Wrap root with <QueryClientProvider client={queryClient}> importing queryClient from "@/lib/queryClient"

QUALITY BAR:
Build as if a senior designer reviewed every pixel. Use the design tokens above — consistent spacing, shadows, rounded corners.`,

  backend: `You are the BuildForge Backend Engineer. You write robust Node.js/TypeScript API code.
Framework: Hono.js (preferred), Express.js, or Fastify — all are acceptable.
All endpoints must: validate input with Zod, return consistent JSON, handle errors with proper status codes.
Use Supabase (@supabase/supabase-js) for database access unless the project specifies otherwise.
Never expose internal errors to clients.`,

  db: `You are the BuildForge Database Engineer. You design and write database schemas.
Default: Supabase (PostgreSQL) — generate CREATE TABLE SQL for the Supabase dashboard.
Follow these rules: snake_case columns, explicit FK constraints, created_at TIMESTAMPTZ DEFAULT now(),
soft deletes where appropriate, proper index strategy. Also provide TypeScript interfaces for each table.`,

  security: `You are the BuildForge Security Analyst. You identify vulnerabilities and harden code.
Check for: injection attacks, auth bypass, insecure defaults, sensitive data exposure, CORS misconfig.
For each finding: severity (CRITICAL/HIGH/MEDIUM/LOW), location, description, and remediation code.
Output structured JSON with a findings array.`,

  connection: `You are the BuildForge Integration Engineer. You wire together services and APIs.
Write integration code for: external APIs, webhooks, message queues, caches.
Ensure: retry logic, timeout handling, circuit breakers, proper error propagation.`,

  fix: `You are the BuildForge Bug Fixer. You diagnose and repair code issues.
Given the error and context, identify root cause and produce a minimal, correct fix.
Output: root cause explanation, the exact diff/replacement code, and test cases for the fix.`,

  deploy: `You are the BuildForge Deployment Engineer. You manage CI/CD and infrastructure.
Write: Dockerfile, GitHub Actions workflows, Kubernetes manifests, or platform config as needed.
Ensure: health checks, graceful shutdown, environment variable management, rollback strategy.`,

  monitor: `You are the BuildForge Monitoring Engineer. You set up observability.
Configure: structured logging, metrics collection, distributed tracing, alerting rules.
Output configuration files and instrumentation code for the specified stack.`,
};

// ── Framework detection + per-framework rules ─────────────────────────────────

export type Framework = "react" | "vue" | "nextjs" | "svelte" | "solid" | "preact" | "tanstack";
export type Database = "supabase" | "mongodb";

/**
 * Detect which frontend framework the user is requesting.
 * React is the default when no specific framework keyword is found.
 */
export function detectFramework(prompt: string, fallback: Framework = "react"): Framework {
  if (/\bpreact\b/i.test(prompt)) return "preact";
  if (/\bvue\b/i.test(prompt)) return "vue";
  if (/\btanstack[- ]?start\b|\btanstack\b|\btss\b/i.test(prompt)) return "tanstack";
  if (/\bnext\.?js\b|\bnextjs\b|\bnext\s+js\b/i.test(prompt)) return "nextjs";
  if (/\bsvelte\b/i.test(prompt)) return "svelte";
  if (/\bsolid\.?js\b|\bsolidjs\b|\bsolid[- ]?js\b/i.test(prompt)) return "solid";
  // React/Vite, and Python/FastAPI/Django prompts (which pair a React+Vite
  // frontend with a non-Node backend) all use the React frontend template.
  if (/\breact\b|\bvite\b|\bpython\b|\bfastapi\b|\bdjango\b/i.test(prompt)) return "react";
  return fallback;
}

export type FullstackFramework = "react" | "nextjs" | "tanstack";

export function detectFullstackFramework(prompt: string): FullstackFramework {
  if (/\btanstack[- ]?start\b|\btanstack\b|\btss\b/i.test(prompt)) return "tanstack";
  if (/\bnext\.?js\b|\bnextjs\b|\bnext\s+js\b/i.test(prompt)) return "nextjs";
  return "react";
}

const FRAMEWORK_RULES: Record<Framework, string> = {
  react: `

DESIGN SYSTEM — follow every rule below:

STYLING:
- ALWAYS use Tailwind CSS utility classes for ALL styling — no inline styles, no CSS modules, no styled-components
- Use shadcn/ui components for buttons, forms, dialogs, dropdowns, tabs, cards, badges, avatars, toasts, tooltips — import from "@/components/ui/X"
- Always use cn() from "@/lib/utils" for conditional classes
- Color system: use CSS variables via Tailwind (bg-background, text-foreground, bg-primary, text-primary-foreground, bg-muted, bg-card, border-border, etc.)
- Dark mode: use dark: prefix — system is pre-configured
- Icons: ALWAYS use lucide-react — import only what you need: import { X, Plus, Settings } from "lucide-react"
- Data fetching: use TanStack Query (useQuery, useMutation) — never raw useState+useEffect for async data
  import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
  Wrap the root (or App.tsx) with <QueryClientProvider client={queryClient}> — import queryClient from "@/lib/queryClient"
- Typography: text-sm, text-base, text-lg, text-xl, text-2xl, text-3xl, font-medium, font-semibold, font-bold
- Spacing: p-4, p-6, gap-4, gap-6, space-y-4 — consistent 4px grid
- Rounded: rounded-md (default), rounded-lg (cards), rounded-full (avatars/pills)
- Shadows: shadow-sm (subtle), shadow-md (cards), shadow-lg (modals)

COMPONENT PATTERNS:
- Page wrapper: <div className="min-h-screen bg-background"><div className="container mx-auto px-4 py-8">
- Card: <div className="rounded-lg border bg-card p-6 shadow-sm">
- Primary button: <button className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md font-medium transition-colors">
- Input: use shadcn Input component or <input className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
- Loading state: <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
- Empty state: <div className="flex flex-col items-center justify-center h-64 text-muted-foreground"><Icon className="h-12 w-12 mb-4 opacity-50" /><p className="text-lg font-medium">No items yet</p></div>`,
  vue: "",
  nextjs: "",
  tanstack: "",
  svelte: "",
  solid: "",
  preact: "",
};

// ── Database detection + per-database rules ───────────────────────────────────

/**
 * Detect which cloud database the user is requesting.
 * Supabase is the default when no specific DB keyword is found.
 */
export function detectDatabase(prompt: string): Database {
  if (/\bmongo(db)?\b/i.test(prompt)) return "mongodb";
  return "supabase";
}

export const DB_INSTRUCTIONS: Record<Database, string> = {
  supabase: `
DATABASE: Supabase (PostgreSQL) — the Hono BACKEND accesses it server-side via
@supabase/supabase-js (NOT directly from the frontend; the frontend calls /api).

DB CLIENT — at the top of src/server/routes/api.ts:
  import { createClient } from '@supabase/supabase-js'
  // Service key (full access, bypasses RLS — backend-only) when present, else anon.
  const db = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '',
  )
  // read:  const { data, error } = await db.from('riders').select('*')
  // write: const { data, error } = await db.from('riders').insert(body).select().single()

DB SCHEMA FILES (also generate):
1. \`\`\`filename:src/db/types.ts   — TypeScript interface per table row (shared)
2. \`\`\`filename:src/db/schema.sql — CREATE TABLE statements (+ RLS) to run in Supabase

The env (SUPABASE_URL + keys) is injected by the preview — do NOT generate .env
or package.json. Read everything from process.env in the backend.`,

  mongodb: `
DATABASE: MongoDB Atlas (via Mongoose)

DATABASE RULES:
- Use mongoose — it connects to MongoDB Atlas over TLS, which WebContainers support (HTTPS/WSS only).
- Define all Mongoose schemas and model exports in src/db/schema.ts.
- Connect lazily at startup in src/lib/db.ts using MONGODB_URI from env.
- Every schema gets { timestamps: true } — Mongoose auto-adds createdAt + updatedAt.
- Use .lean() on read queries (returns plain JS objects, faster serialisation).
- Do NOT add a separate mongodb driver — mongoose bundles it.
- Field types: String, Number, Boolean, Date, Schema.Types.ObjectId, [String] for arrays.

DB SCHEMA FILE:
1. \`\`\`filename:src/db/schema.ts — Mongoose schemas + model exports

DB CLIENT — \`\`\`filename:src/lib/db.ts:
  import mongoose from 'mongoose'
  let _connected = false
  export async function connectDB(): Promise<void> {
    if (_connected) return
    await mongoose.connect(process.env.MONGODB_URI!)
    _connected = true
  }

API ROUTES EXAMPLE — src/server/routes/api.ts:
  import { connectDB } from '../../lib/db'
  import { Item } from '../../db/schema'
  api.get('/items', async (c) => {
    await connectDB()
    const items = await Item.find().sort({ createdAt: -1 }).lean()
    return c.json(items)
  })
  api.post('/items', async (c) => {
    await connectDB()
    const body = await c.req.json()
    const item = await Item.create(body)
    return c.json(item.toObject(), 201)
  })
  api.delete('/items/:id', async (c) => {
    await connectDB()
    const { id } = c.req.param()
    await Item.findByIdAndDelete(id)
    return c.body(null, 204)
  })

mongoose (+ mongodb driver bundled) is pre-installed. MONGODB_URI is injected by
the preview env — do NOT generate .env or package.json. The frontend always
calls same-origin /api (no VITE_API_URL). connectDB() must run at the start of
every route (idempotent) so the lazy connection is established.`,
};

// ── Fullstack mode instruction ────────────────────────────────────────────────
// Appended to the frontend system prompt when the task is a full-stack build.
// DB-specific rules are injected separately via DB_INSTRUCTIONS[db].
// Detected by the "FULLSTACK BUILD:" description prefix set in build.ts.

export const FULLSTACK_INSTRUCTION = `

## ARCHITECTURE — REAL BACKEND (Hono on Node) + REACT FRONTEND

This app ships a REAL backend server with real API routes — not just direct
DB calls from the frontend. The preview runs BOTH: a Vite frontend on :5173 and
a Hono (Node) backend on :3001. Vite proxies /api/* to the backend, so the
frontend calls same-origin '/api/...'. This is how you build real /api/riders,
/api/orders, Stripe /api/webhooks, and any custom server-side logic.

DATA: the backend reads/writes its database server-side using EXACTLY the DB
client described in the DATABASE section below (Supabase OR MongoDB — never
both). Generate the DB schema file(s) from that section FIRST so they're never
dropped when output is long.

GENERATE THESE FILES (this exact set is the backbone, IN ADDITION to the DB
schema file(s) from the DATABASE section — generate the backend FIRST so it's
never dropped when output is long):

1. \`\`\`filename:src/server/index.ts — the Hono server. EXACT shape:
     import { serve } from '@hono/node-server'
     import { Hono } from 'hono'
     import { cors } from 'hono/cors'
     import { api } from './routes/api.js'
     const app = new Hono()
     app.use('/*', cors())
     app.route('/api', api)
     serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3001 })
     console.log('API on :' + (process.env.PORT || 3001))

2. \`\`\`filename:src/server/routes/api.ts — ALL API routes on a Hono router.
   Read/write data with the DB CLIENT defined in the DATABASE section below
   (Supabase OR MongoDB — exactly the one specified there; never mix two DBs).
   ALWAYS handle errors so the server never crashes (return [] / an error json,
   never throw). Shape:
     import { Hono } from 'hono'
     // ...import the DB client per the DATABASE section...
     export const api = new Hono()
     api.get('/riders', async (c) => {
       try { /* read via the DB client */ return c.json(rows ?? []) }
       catch { return c.json([], 200) }   // not set up yet → empty, don't crash
     })
     api.post('/riders', async (c) => {
       const body = await c.req.json().catch(() => ({}))
       try { /* insert via the DB client */ return c.json(created, 201) }
       catch (e) { return c.json({ error: String(e) }, 400) }
     })
   Add every route the app needs (orders, webhooks, etc.) in this same style.
   For Stripe webhooks: a route like api.post('/webhooks/stripe', ...) that
   reads the raw body — keep it defensive (try/catch, 200 by default).

3. \`\`\`filename:src/lib/api.ts — typed frontend fetch wrappers, same-origin:
     import type { Rider } from '../db/types' // or wherever the DATABASE section defines row types
     export async function getRiders(): Promise<Rider[]> {
       const r = await fetch('/api/riders'); if (!r.ok) return []; return r.json()
     }
     export async function createRider(input: Partial<Rider>): Promise<Rider | null> {
       const r = await fetch('/api/riders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
       return r.ok ? r.json() : null
     }

4. \`\`\`filename:src/App.tsx — the React UI. Imports the wrappers from ./lib/api
   and renders the app (loading + error + empty states). Show the MAIN UI first
   (not a login wall). Polished, complete, realistic.

5. \`\`\`filename:src/index.tsx — standard React 18 createRoot rendering <App/> + './styles.css'.
6. \`\`\`filename:src/styles.css — app styles.

HARD RULES:
- The frontend talks to the backend ONLY through src/lib/api.ts (fetch '/api/...').
  Never put a hardcoded http://localhost or external URL — always relative '/api'.
- The backend listens on Number(process.env.PORT) || 3001. Never hardcode another port.
- Every file COMPLETE and non-empty. Backend routes must never throw uncaught.
- Do NOT emit package.json, vite.config.ts, tsconfig.json, index.html, or .env —
  the environment provides them and injects the DB env per the DATABASE section.

DESIGN SYSTEM — same rules apply here as in the React template:
- ALWAYS use Tailwind CSS — no inline styles
- Use shadcn/ui components (import from "@/components/ui/X") for all UI primitives
- Use cn() from "@/lib/utils" for conditional classes
- Icons: lucide-react only
- Data fetching: TanStack Query (useQuery, useMutation) — import queryClient from "@/lib/queryClient" and wrap with QueryClientProvider
- Color tokens: bg-background, text-foreground, bg-primary, bg-muted, bg-card, border-border

ALLOWED IMPORTS (frontend): react, react-dom, @tanstack/react-query, lucide-react,
@radix-ui/react-*, class-variance-authority, clsx, tailwind-merge, plus EXACTLY the
DB/auth libraries named below. All pre-installed. Do not import other libraries.
ALLOWED IMPORTS (backend/server): hono, @hono/node-server, zod, plus EXACTLY the
DB/auth libraries named in the DATABASE/AUTH sections below.`;

// Use a Python/FastAPI backend when the prompt asks for it (or implies a
// Python-only ecosystem: ML/data work).
export const PYTHON_BACKEND_RE = /\b(python|fastapi|flask|django|pandas|numpy|scikit|pytorch|tensorflow|data\s*science|machine\s*learning)\b/i;

export const FASTAPI_OVERRIDE = `

## PYTHON BACKEND OVERRIDE — use FastAPI instead of Hono/Node

The user wants a Python backend. REPLACE the Node/Hono backend with FastAPI.
Do NOT generate src/server/index.ts, src/server/routes/api.ts, or any .ts
backend file. Everything else (the React frontend + src/lib/api.ts calling
'/api/...') stays exactly the same — Vite proxies /api to this server on :3001.

Generate INSTEAD:

1. \`\`\`filename:src/server/main.py — a FastAPI app. The ASGI app MUST be named
   exactly \`app\`. All routes under /api. Use the supabase Python client; handle
   errors so the server never crashes on startup. EXACT shape:
     import os
     from fastapi import FastAPI, Request
     from fastapi.middleware.cors import CORSMiddleware
     from supabase import create_client
     app = FastAPI()
     app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
     # Service key (full access) when present, else anon. Both come from env.
     _key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY") or ""
     supabase = create_client(os.environ.get("SUPABASE_URL", ""), _key)

     @app.get("/api/riders")
     def list_riders():
         try:
             return (supabase.table("riders").select("*").order("created_at", desc=True).execute()).data or []
         except Exception:
             return []

     @app.post("/api/riders")
     async def create_rider(req: Request):
         body = await req.json()
         try:
             res = supabase.table("riders").insert(body).execute()
             return (res.data or [None])[0]
         except Exception as e:
             return {"error": str(e)}
   Add every route the app needs in this same defensive style.

2. \`\`\`filename:requirements.txt — list: fastapi, uvicorn, supabase
   (these are pre-installed in the environment; list them for completeness).

The server is started for you as: uvicorn main:app --port 3001 (from src/server).
Do NOT write your own __main__ / uvicorn.run() block.`;

// ── Auth sub-mode instruction ─────────────────────────────────────────────────
// Appended after FULLSTACK_INSTRUCTION when the task prefix is "FULLSTACK AUTH BUILD:".

export const FULLSTACK_AUTH_INSTRUCTION = `

AUTH MODE — This app requires user authentication. Generate the full Supabase auth setup in addition to all base fullstack files.

ADDITIONAL FILES — generate these AFTER the base files (numbered continuing from 10):
11. \`\`\`filename:src/lib/supabase.ts
    Use this EXACT content:
    \`\`\`
    import { createClient } from '@supabase/supabase-js'
    export const supabase = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY
    )
    \`\`\`

12. \`\`\`filename:src/hooks/useAuth.ts
    - Import supabase from '../lib/supabase'
    - Export default function useAuth()
    - Returns: { user, session, loading, signIn, signUp, signOut, signInWithGoogle, signInWithGithub }
    - On mount: call supabase.auth.getSession(), set user + session, then set loading=false
    - Subscribe: supabase.auth.onAuthStateChange((_, session) => { setSession(session); setUser(session?.user ?? null); })
    - signIn(email, password): return supabase.auth.signInWithPassword({ email, password })
    - signUp(email, password): return supabase.auth.signUp({ email, password })
    - signOut(): return supabase.auth.signOut()
    - signInWithGoogle(): return supabase.auth.signInWithOAuth({ provider: 'google' })
    - signInWithGithub(): return supabase.auth.signInWithOAuth({ provider: 'github' })

13. \`\`\`filename:src/components/AuthProvider.tsx
    - Create AuthContext with { user, session, loading, signIn, signUp, signOut, signInWithGoogle, signInWithGithub }
    - AuthProvider component: uses useAuth() internally, provides context to children
    - While loading is true, render a centered loading spinner (inline CSS, no libraries)
    - Export useAuthContext() hook: returns useContext(AuthContext)
    - Export default AuthProvider

14. \`\`\`filename:src/components/Login.tsx
    - Rendered as a MODAL/OVERLAY (dimmed full-screen backdrop + centered card),
      NOT a full-page route. Props: { onClose?: () => void }.
    - A close (×) button in the card corner calls onClose; clicking the backdrop
      also closes. Auto-close when login succeeds (useAuthContext().user != null
      → call onClose in a useEffect).
    - Two tabs: "Sign In" | "Sign Up" — switching changes the form
    - Email + password fields (controlled inputs) — EMAIL/PASSWORD IS THE PRIMARY
      path and works in the preview.
    - "Continue with Google" (#DB4437) and "Continue with GitHub" (#24292e)
      buttons calling the matching useAuthContext() method. Show a small note:
      "Social login works on the deployed site" (OAuth can't redirect inside the
      preview iframe). Keep them, just don't rely on them for the preview.
    - Error message display (red text, below the form)
    - Loading state: disable buttons and show "Loading..." during async calls
    - Export default Login (accepting the optional onClose prop)

15. \`\`\`filename:README.md may document these env vars (the preview already
    provides them; the user sets their own when they deploy):
    \`\`\`
    VITE_SUPABASE_URL=your_supabase_url
    VITE_SUPABASE_ANON_KEY=your_anon_key
    \`\`\`

16. \`\`\`filename:README.md
    Use this EXACT content (fill in the app name at the top):
    \`\`\`
    # [App Name]

    ## Auth Setup

    1. Create a Supabase project at https://supabase.com
    2. Enable Google and/or GitHub in **Supabase Dashboard → Authentication → Providers**
    3. Copy your Project URL and anon key from **Project Settings → API**
    4. Create a \`.env\` file from \`.env.example\` and fill in the values:
       \`\`\`
       VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
       VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
       \`\`\`
    5. Add your OAuth redirect URL in the Supabase dashboard:
       **Authentication → URL Configuration → Redirect URLs**
       \`\`\`
       https://your-project.supabase.co/auth/v1/callback
       \`\`\`

    > ⚠️ **OAuth (Google/GitHub) does NOT work in the iframe preview.**
    > Test on the published URL after deploying.
    \`\`\`

(@supabase/supabase-js is already installed in the preview — do NOT edit package.json.)

APP.TSX — integrate auth WITHOUT a hard login wall:
- Import AuthProvider + useAuthContext from './components/AuthProvider', Login from './components/Login'.
- The root wraps everything in <AuthProvider>.
- DO NOT block the whole app behind login. The app's MAIN UI must render first
  (logged-out state visible). Only when the user opens login do you show the
  <Login /> modal. This way the preview shows the actual app, not a login wall.
- EXACTLY ONE visible "Sign In" button — in the HEADER. Do NOT add extra Sign In
  buttons, "Sign in to…" banners, or sample-data notices anywhere else. The
  logged-out state just shows the real UI with sample/empty data; that's enough.
- Actions that need a user (e.g. Save) call setShowLogin(true) to open the SAME
  modal — they must NOT render their own Sign In button. When signed out, such a
  button keeps its normal label (e.g. "Save"); clicking it opens login.
- Logged-in state: replace the header Sign In with the user's email + a "Sign
  out" button, and load their real data via the supabase client.
- Example skeleton:
    function AppContent() {
      const { user, loading } = useAuthContext();
      const [showLogin, setShowLogin] = useState(false);
      if (loading) return <div>Loading...</div>;
      return (
        <div>
          <header>
            <span>MyApp</span>
            {user ? (
              <SignOutButton />
            ) : (
              <button onClick={() => setShowLogin(true)}>Sign In</button>
            )}
          </header>
          <MainUI onRequireAuth={() => setShowLogin(true)} />
          {showLogin && !user && (
            <Login onClose={() => setShowLogin(false)} />
          )}
        </div>
      );
    }
    export default function App() {
      return (
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      );
    }
- <MainUI> renders the app for everyone; when logged out, calls onRequireAuth()
  for actions that need a signed-in user. Login should auto-close once user != null.`;

// ── MongoDB auth (custom JWT — MongoDB has no built-in auth like Supabase) ─────
const MONGODB_AUTH_INSTRUCTION = `

AUTH MODE (MongoDB) — MongoDB has NO built-in auth service, so build a real
custom JWT auth in the Hono backend. Generate:

1. \`\`\`filename:src/server/routes/auth.ts — Hono router with register + login,
   using bcryptjs (hash) + jsonwebtoken (sign with process.env.JWT_SECRET), and a
   User mongoose model (email unique + passwordHash). EXACT shape:
     import { Hono } from 'hono'
     import bcrypt from 'bcryptjs'
     import jwt from 'jsonwebtoken'
     import mongoose from 'mongoose'
     import { connectDB } from '../../lib/db.js'
     const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema(
       { email: { type: String, unique: true, required: true }, passwordHash: String },
       { timestamps: true }))
     const SECRET = process.env.JWT_SECRET || 'dev'
     export const auth = new Hono()
     auth.post('/register', async (c) => {
       await connectDB(); const { email, password } = await c.req.json()
       if (!email || !password) return c.json({ error: 'email & password required' }, 400)
       if (await User.findOne({ email })) return c.json({ error: 'email taken' }, 409)
       const u = await User.create({ email, passwordHash: await bcrypt.hash(password, 10) })
       return c.json({ token: jwt.sign({ sub: u.id, email }, SECRET, { expiresIn: '7d' }), user: { id: u.id, email } }, 201)
     })
     auth.post('/login', async (c) => {
       await connectDB(); const { email, password } = await c.req.json()
       const u = await User.findOne({ email })
       if (!u || !(await bcrypt.compare(password, u.passwordHash))) return c.json({ error: 'invalid credentials' }, 401)
       return c.json({ token: jwt.sign({ sub: u.id, email }, SECRET, { expiresIn: '7d' }), user: { id: u.id, email } })
     })
   Mount it in src/server/index.ts:  app.route('/api/auth', auth)

2. A requireAuth helper (verify the Bearer token with jwt.verify) used by routes
   that need a logged-in user; read user id from the token, scope data by it.

3. FRONTEND: src/lib/api.ts stores the JWT in localStorage after register/login
   and sends it as 'Authorization: Bearer <token>' on every /api call. The
   useAuth hook tracks { user, token }. Same app-first UI as the Supabase flow:
   main UI renders for everyone, ONE 'Sign In' button opens a Login modal
   (email/password → POST /api/auth/login|register), modal auto-closes on success.
   No social/OAuth (custom auth is email/password).`;

// ── Next.js fullstack instruction ─────────────────────────────────────────────
export const NEXTJS_INSTRUCTION = `

## ARCHITECTURE — NEXT.JS APP ROUTER + API ROUTES (no separate server process)

This is a fullstack Next.js App Router application. The API backend is built using
Next.js Route Handlers (app/api/) — there is NO separate Hono/Node server process.
The preview runs a SINGLE \`next dev\` process on :3000.

GENERATE THESE FILES (generate API routes FIRST so they're never dropped):

1. \`\`\`filename:app/api/[collection]/route.ts — Route Handler per resource. EXACT shape:
     import { NextRequest, NextResponse } from 'next/server'
     // ...import DB client per DATABASE section...
     export async function GET() {
       try { /* read from DB */ return NextResponse.json(rows ?? []) }
       catch { return NextResponse.json([], { status: 200 }) }
     }
     export async function POST(req: NextRequest) {
       try {
         const body = await req.json()
         /* insert into DB */
         return NextResponse.json(created, { status: 201 })
       } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }) }
     }
   Create one route.ts per resource under app/api/[resourceName]/route.ts.
   For Stripe webhooks: app/api/webhooks/stripe/route.ts.

2. \`\`\`filename:app/page.tsx — Main page, Server Component by default.
   Fetch data using server-side DB client directly (no fetch() to /api for page data —
   Server Components can call the DB directly). "use client" only for interactive parts.

3. \`\`\`filename:app/layout.tsx — Root layout:
     import './globals.css'
     export default function RootLayout({ children }: { children: React.ReactNode }) {
       return <html lang="en"><body>{children}</body></html>
     }

4. \`\`\`filename:app/globals.css — app styles (CSS variables, global resets).

5. next.config.js is provided by the sandbox environment — do NOT generate next.config.js or next.config.ts.

HARD RULES:
- NO separate Hono/Node server — Next.js Route Handlers ARE the backend.
- Server Components can query the DB directly (server-side only, no leaking keys).
- Client Components ("use client") must use fetch('/api/...') — never import DB client.
- The DB client (per DATABASE section) is server-only — only import in Server Components
  or Route Handlers, never in "use client" components.
- Do NOT emit package.json or .env — the environment provides them.
- Do NOT generate src/index.tsx, src/App.tsx, or src/styles.css — this is Next.js App Router, not React/Vite.
- Port is 3000 (next dev default) — do NOT hardcode another port.

ALLOWED IMPORTS: react, react-dom, next, lucide-react, @tanstack/react-query, plus
EXACTLY the DB/auth libraries named in the DATABASE/AUTH sections below.
All pre-installed. Do not import other libraries.`;

// ── TanStack Start fullstack instruction ──────────────────────────────────────
export const TANSTACK_INSTRUCTION = `

## ARCHITECTURE — TANSTACK START (full-stack server functions, no separate server)

This is a fullstack TanStack Start application. The backend is built using TanStack
Start's createServerFn — server functions that run ONLY on the server and can access
the DB directly. NO separate Hono/Node server process.

GENERATE THESE FILES (generate server functions FIRST):

1. \`\`\`filename:app/routes/__root.tsx — root route. EXACT shape:
     import { createRootRoute, Outlet } from '@tanstack/react-router'
     import '../globals.css'
     export const Route = createRootRoute({
       component: () => <Outlet />,
     })

2. \`\`\`filename:app/routes/index.tsx — index route. Uses createServerFn to fetch data:
     import { createFileRoute } from '@tanstack/react-router'
     import { createServerFn } from '@tanstack/start'
     // ...import DB client per DATABASE section (server-only)...
     const getItems = createServerFn({ method: 'GET' }).handler(async () => {
       /* read from DB — this runs server-side only */
       return items ?? []
     })
     export const Route = createFileRoute('/')({
       loader: () => getItems(),
       component: function IndexPage() {
         const items = Route.useLoaderData()
         return <main>{/* render items */}</main>
       },
     })

3. \`\`\`filename:app/client.tsx — client entry:
     import { StartClient } from '@tanstack/start'
     import { createRouter } from './router'
     import { hydrateRoot } from 'react-dom/client'
     const router = createRouter()
     hydrateRoot(document, <StartClient router={router} />)

4. \`\`\`filename:app/router.tsx — router config:
     import { createRouter as createTanStackRouter } from '@tanstack/react-router'
     import { routeTree } from './routeTree.gen'
     export function createRouter() {
       return createTanStackRouter({ routeTree })
     }

5. \`\`\`filename:app/globals.css — app styles (CSS variables, global resets).

6. \`\`\`filename:app.config.ts — TanStack Start config:
     import { defineConfig } from '@tanstack/start/config'
     export default defineConfig({ react: {} })

HARD RULES:
- Server functions (createServerFn) run server-side only — safe to import DB client there.
- Client-rendered code must use TanStack Router loaders (which call server functions)
  to get data — never import DB client in client components.
- Do NOT generate a Hono server or src/server/ directory.
- Do NOT emit package.json or .env — the environment provides them.
- For mutations: use createServerFn({ method: 'POST' }) and call it from a form or button handler.

ALLOWED IMPORTS: react, react-dom, @tanstack/start, @tanstack/react-router, plus EXACTLY
the DB/auth libraries named in the DATABASE/AUTH sections below. All pre-installed.
Do not import other libraries.`;

// ── JSON output instruction appended for structured agents ────────────────────
const JSON_OUTPUT_AGENTS: Set<AgentTaskType> = new Set([
  "security",
  "db",
  "planning",
]);

// ── Prompt expansion ──────────────────────────────────────────────────────────

// Per-app-type feature expectations appended to short prompts so the model
// builds the COMPLETE version rather than a skeleton. Runs before the main build.
const APP_TYPE_EXPANSIONS: Array<{ match: RegExp; expansion: string }> = [
  {
    match: /\btodo|task list|task manager\b/i,
    expansion: `Build a COMPLETE task management app with ALL these features:
- Add tasks with title, priority (High/Medium/Low badge), and due date
- Priority color-coded badges: High=red, Medium=yellow/amber, Low=green
- Filter tabs: All / Active / Completed — each showing filtered count
- Sort controls: by Priority / Due Date / Created
- Task count display (e.g. "3 of 7 tasks remaining")
- Delete and toggle-complete for every task
- Empty state message when no tasks match the current filter
- Keyboard shortcut: press Enter in the input to add a task
- Clean, polished UI with smooth hover/transition effects
- Pre-load 4–5 realistic sample tasks relevant to the app's domain.
  Use fresh, varied task names every time — NEVER generic "Task 1" placeholders.`,
  },
  {
    match: /\bdashboard|admin panel|analytics\b/i,
    expansion: `Build a COMPLETE analytics dashboard with ALL these sections:
- Sidebar with navigation items relevant to the domain (with icons via Unicode/SVG)
- 4 KPI cards with trend arrows (↑/↓) and percentage change.
  Use realistic numbers appropriate to the domain — generate fresh values every time,
  do NOT reuse the same numbers across builds.
- SVG bar or line chart (300×160 px minimum) with at least 7 data points and axis labels.
  Use domain-appropriate data — generate varied, realistic values.
- Activity feed or table: 5–8 rows of recent-activity data with realistic names, actions, timestamps, and status badges
- Status badges color-coded: e.g. Completed=green, Pending=yellow, Failed=red
- Professional theme with consistent spacing and typography`,
  },
  {
    match: /\bkanban|board|drag|trello\b/i,
    expansion: `Build a Kanban board WITHOUT any drag-and-drop library.
Use ONLY component state for moving cards between columns — no external DnD libs.
Clicking a card shows a move button: [→ Move to Next Column]
Three columns: Todo, In Progress, Done
Each column has: header with title, task count badge, and list of cards
Each card has: title, priority badge (High/Medium/Low), and a "→ Move" button
Use inline styles only, no CSS frameworks.
Pre-load 6 sample tasks distributed across the three columns.
Use realistic task names relevant to the app's domain — generate fresh names every time.`,
  },
  {
    match: /\blanding page|marketing site|homepage\b/i,
    expansion: "Include: a hero section, features grid, pricing tiers, testimonials, a clear CTA, and a footer.",
  },
  {
    match: /\btimer|stopwatch|pomodoro|countdown\b/i,
    expansion: "Include: start/stop/reset controls, a visual progress indicator, and clean time formatting.",
  },
  {
    match: /\bchat|messaging|messenger\b/i,
    expansion: "Include: a message list, an input box, send-on-Enter, mock conversation data, and auto-scroll to the latest message.",
  },
];

// ── Screenshot / design-reference instruction ────────────────────────────────

const SCREENSHOT_DESIGN_INSTRUCTION = "";

const AGENT_BUILD_INSTRUCTION = "";

const ANIMATION_DEFAULT_INSTRUCTION = "";

/**
 * Expand a short user prompt with completeness expectations for its app type.
 * Pure and additive — never replaces the user's intent, only appends guidance.
 * Call this BEFORE dispatching the main build so the model targets a full app.
 */
export function expandUserPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  const matched = APP_TYPE_EXPANSIONS.filter((e) => e.match.test(trimmed));
  if (matched.length === 0) return trimmed;

  const additions = matched.map((e) => `- ${e.expansion}`).join("\n");
  return `${trimmed}\n\nBuild the complete, fully-functional version:\n${additions}`;
}

/** Returns the base frontend agent system prompt for use in external streaming handlers. */
export function getFrontendSystemPrompt(): string {
  return SYSTEM_PROMPTS.frontend;
}

/** Returns the React framework rules block for use in external streaming handlers. */
export function getReactFrameworkRules(): string {
  return FRAMEWORK_RULES.react ?? "";
}

/** True when the prompt implies user accounts, login, OAuth, or session handling. */
export function needsAuth(prompt: string): boolean {
  return /\b(auth|login|log[- ]in|signin|sign[- ]in|sign[- ]up|signup|register|logout|log[- ]out|oauth|jwt|session|password|credential|account|user account|user profile|admin panel|authentication|authorization)\b/i.test(
    prompt,
  );
}

/** Module-level skill loader — shared by PromptBuilder and stream path. */
async function loadSkillsForPrompt(
  prompt: string,
  opts?: { buildType?: "frontend" | "fullstack" },
): Promise<string> {
  const skillsToLoad = new Set<string>();
  const skillsDir = join(process.cwd(), "src", "skills");

  // FIRECRAWL — only when scraping/crawling requested
  if (/\b(scrape|crawl|firecrawl|web.scraping|extract.from.website|read.website|parse.webpage)\b/i.test(prompt)) {
    skillsToLoad.add("firecrawl");
  }

  // EXA — only when research/semantic search requested
  if (/\b(research.tool|semantic.search|exa|competitor.research|market.research|find.and.analyze|search.the.web)\b/i.test(prompt)) {
    skillsToLoad.add("exa");
  }

  // AI AGENTS — only when explicitly building an agent
  if (/\b(ai.agent|autonomous.agent|crewai|langgraph|multi.agent|agent.workflow|agent.pipeline|background.agent|scheduled.agent|daily.automation|cron.job)\b/i.test(prompt)) {
    skillsToLoad.add("crewai");
    skillsToLoad.add("langgraph");
    skillsToLoad.add("agent-architecture");
  }

  const skillContents: string[] = [];
  for (const skill of skillsToLoad) {
    try {
      const filePath = join(skillsDir, `${skill}.md`);
      const content = await readFile(filePath, "utf-8");
      skillContents.push(`\n\n---\n## Skill: ${skill}\n${content}`);
    } catch {
      // skill file not found — skip silently
    }
  }

  return skillContents.join("");
}

/**
 * Exported for use in the stream path (ai-stream.ts). Defaults to "frontend"
 * because follow-up edits are almost always on frontend (Sandpack) apps —
 * this ensures the frontend-sandbox skill is injected on the stream path.
 */
export async function loadRelevantSkillsForPrompt(
  prompt: string,
  buildType: "frontend" | "fullstack" = "frontend",
): Promise<string> {
  return loadSkillsForPrompt(prompt, { buildType });
}

// ── PromptBuilder ─────────────────────────────────────────────────────────────

export class PromptBuilder {
  private readonly contractsDir: string;

  constructor(contractsDir: string = process.cwd()) {
    this.contractsDir = contractsDir;
  }

  async build(
    agentType: AgentTaskType,
    task: TaskInput,
    context: BuildContext,
    workspaceDir?: string | undefined,
    contextFiles?: Array<{ path: string; content: string }> | undefined,
  ): Promise<BuiltPrompt> {
    // Detect build type from the task description prefix so the right
    // build-type skill (frontend-sandbox vs fullstack-hono) gets injected.
    const buildType: "frontend" | "fullstack" | undefined =
      agentType === "frontend"
        ? (task.description.startsWith("FULLSTACK BUILD:") ||
           task.description.startsWith("FULLSTACK AUTH BUILD:")
            ? "fullstack"
            : "frontend")
        : undefined;

    const [baseSystemPrompt, skillsBlock, contextBlock] = await Promise.all([
      Promise.resolve(this.buildSystemPrompt(agentType, task)),
      this.loadRelevantSkills(context.prompt, buildType),
      this.buildContextBlock(agentType, workspaceDir, contextFiles),
    ]);
    const systemPrompt = skillsBlock
      ? `${baseSystemPrompt}\n\n${skillsBlock}`
      : baseSystemPrompt;
    const taskBlock = this.buildTaskBlock(task, context);

    const userMessage = this.truncate(
      [contextBlock, taskBlock].filter((s) => s.length > 0).join("\n\n"),
      MAX_INPUT_CHARS - systemPrompt.length,
    );

    const estimatedInputTokens =
      Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) +
      Math.ceil(userMessage.length / CHARS_PER_TOKEN);

    logger.debug(
      { agentType, estimatedInputTokens },
      "Prompt built",
    );

    return { systemPrompt, userMessage, estimatedInputTokens };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private buildSystemPrompt(agentType: AgentTaskType, task: TaskInput): string {
    const base = SYSTEM_PROMPTS[agentType];

    const isFullstackMode =
      agentType === "frontend" &&
      (task.description.startsWith("FULLSTACK BUILD:") ||
       task.description.startsWith("FULLSTACK AUTH BUILD:"));
    // Detect the JS framework for fullstack builds (react/nextjs/tanstack only —
    // vue/svelte/solid/preact are Sandpack-only and stay out of E2B).
    const fullstackFramework: FullstackFramework = isFullstackMode
      ? detectFullstackFramework(task.description)
      : "react";

    // FASTAPI_OVERRIDE only applies to react fullstack (Hono → FastAPI swap).
    // Next.js and TanStack have their own backend model (API routes / server functions).
    const wantsPython = isFullstackMode && fullstackFramework === "react" && PYTHON_BACKEND_RE.test(task.description);

    const fullstackInstruction = isFullstackMode
      ? (fullstackFramework === "nextjs"
          ? NEXTJS_INSTRUCTION
          : fullstackFramework === "tanstack"
            ? TANSTACK_INSTRUCTION
            : FULLSTACK_INSTRUCTION + (wantsPython ? FASTAPI_OVERRIDE : ""))
      : "";

    // framework detection for frameworkInstruction (Sandpack rules):
    // - For fullstack nextjs/tanstack: skip FRAMEWORK_RULES (their instruction covers everything).
    // - For fullstack react: use FRAMEWORK_RULES.react (gives sandbox restrictions + fetch exception).
    // - For Sandpack builds: detect from prompt, can be any framework.
    const framework = agentType === "frontend"
      ? (isFullstackMode && fullstackFramework !== "react"
          ? fullstackFramework  // nextjs or tanstack — frameworkInstruction will be "" below
          : detectFramework(task.description, "react"))
      : "react";
    const frameworkInstruction = agentType === "frontend"
      ? (isFullstackMode && fullstackFramework !== "react" ? "" : FRAMEWORK_RULES[framework])
      : "";

    const db = isFullstackMode ? detectDatabase(task.description) : "supabase";
    const dbInstruction = isFullstackMode ? DB_INSTRUCTIONS[db] : "";

    const isFullstackAuthMode =
      agentType === "frontend" &&
      task.description.startsWith("FULLSTACK AUTH BUILD:");
    // TanStack uses Vite/import.meta.env, compatible with FULLSTACK_AUTH_INSTRUCTION. Next.js needs separate NEXT_PUBLIC_* pattern — not yet implemented.
    // For react+mongodb: custom JWT. For react/tanstack+supabase: Supabase auth.
    const authInstruction = isFullstackAuthMode && (fullstackFramework === "react" || fullstackFramework === "tanstack")
      ? (db === "mongodb" ? MONGODB_AUTH_INSTRUCTION : FULLSTACK_AUTH_INSTRUCTION)
      : "";

    const isEditMode =
      agentType === "frontend" &&
      task.description.startsWith("EXISTING PROJECT FILES:") &&
      !task.projectMemory;
    const editModeInstruction = isEditMode
      ? "\n\nEDIT MODE — You are modifying an existing app:\n" +
        "- Preserve the existing design system, colors, and component patterns\n" +
        "- Only change what the user explicitly asked for\n" +
        "- Preserve all working functionality and state management\n" +
        "- Do NOT redesign or restructure anything the user did not mention\n\n" +
        "SURGICAL EDITS — use for small, targeted changes:\n" +
        "If fewer than 50% of a file changes, wrap ONLY the changed section:\n" +
        "  // BEGIN_EDIT: [brief description of what changes]\n" +
        "  [new content for this section only — must include the full block, e.g. the full :root { } rule]\n" +
        "  // END_EDIT\n" +
        "The system will splice this in place of the matching section in the existing file.\n" +
        "If more than 50% of a file changes, output the COMPLETE file as normal.\n" +
        "Always output at least the files provided in context — omit only src/index.tsx and package.json if unchanged."
      : "";

    const jsonInstruction =
      JSON_OUTPUT_AGENTS.has(agentType) || task.outputFormat === "json"
        ? "\n\nRESPONSE FORMAT: Output valid JSON only. No prose outside the JSON structure."
        : "";

    // Connected-service codegen hints (WordPress/Shopify/Make/n8n/Zapier) when
    // the prompt mentions them.
    const providerRules = agentType === "frontend" ? matchProviderRules(task.description) : "";

    const screenshotInstruction = task.hasReferenceImage === true ? SCREENSHOT_DESIGN_INSTRUCTION : "";
    const agentBuildInstruction = task.isAgentBuild === true ? AGENT_BUILD_INSTRUCTION : "";
    const animationInstruction = task.hasAnimationContext === true ? ANIMATION_DEFAULT_INSTRUCTION : "";

    const projectMemoryBlock = task.projectMemory
      ? `🚨 CRITICAL: This is an EDIT to an existing app. DO NOT rebuild or rewrite the entire application. DO NOT change the app name, design, or structure. ONLY add/modify what the user specifically asked for. Make SURGICAL changes only.\n\n## Current Project State\n${task.projectMemory}\n\nEDIT RULES:\n- Preserve all existing design decisions unless user explicitly changes them\n- Keep the same color palette, fonts, and component patterns\n- Only modify what the user asked to change\n- Do not rename existing components or restructure working code\n- Read existing file structure before writing any changes\n\n`
      : "";

    return projectMemoryBlock + base + frameworkInstruction + fullstackInstruction + dbInstruction + authInstruction + editModeInstruction + providerRules + screenshotInstruction + agentBuildInstruction + animationInstruction + jsonInstruction;
  }

  private async buildContextBlock(
    agentType: AgentTaskType,
    workspaceDir?: string | undefined,
    contextFiles?: Array<{ path: string; content: string }> | undefined,
  ): Promise<string> {
    const files = this.relevantFiles(agentType);
    const sections: string[] = [];

    // Pre-selected context files from ContextManager (injected before standard brain files)
    if (contextFiles !== undefined && contextFiles.length > 0) {
      const seenPaths = new Set(contextFiles.map((f) => f.path));
      for (const { path, content } of contextFiles) {
        sections.push(`## ${path}\n${content}`);
      }
      // Exclude already-included brain files from the standard block
      const remainingBrainFiles = files.filter((name) => !seenPaths.has(name));
      for (const filename of remainingBrainFiles) {
        const dirs = workspaceDir !== undefined ? [workspaceDir, this.contractsDir] : [this.contractsDir];
        let content: string | null = null;
        for (const dir of dirs) {
          content = await this.readFileFrom(dir, filename);
          if (content !== null) break;
        }
        if (content !== null) sections.push(`## ${filename}\n${content}`);
      }
      return sections.join("\n\n");
    }

    // Read from workspace dir first (project-specific brain files), fallback to contractsDir
    const dirs = workspaceDir !== undefined ? [workspaceDir, this.contractsDir] : [this.contractsDir];
    const seen = new Set<string>();

    for (const filename of files) {
      if (seen.has(filename)) continue;
      seen.add(filename);
      let content: string | null = null;
      for (const dir of dirs) {
        content = await this.readFileFrom(dir, filename);
        if (content !== null) break;
      }
      if (content !== null) {
        sections.push(`## ${filename}\n${content}`);
      }
    }

    return sections.join("\n\n");
  }

  private buildTaskBlock(task: TaskInput, context: BuildContext): string {
    const parts = [
      `## Task`,
      task.description,
    ];

    if (task.requirements !== undefined && task.requirements.length > 0) {
      parts.push("## Requirements", task.requirements.map((r) => `- ${r}`).join("\n"));
    }

    if (task.constraints !== undefined && task.constraints.length > 0) {
      parts.push("## Constraints", task.constraints.map((c) => `- ${c}`).join("\n"));
    }

    if (task.targetFiles !== undefined && task.targetFiles.length > 0) {
      parts.push("## Target Files", task.targetFiles.join(", "));
    }

    parts.push(
      "## Project Context",
      `- Project ID: ${context.projectId}`,
      `- Build mode: ${context.mode}`,
      `- User prompt: ${context.prompt}`,
    );

    const bc = context.businessContext;
    if (bc !== undefined) {
      const lines: string[] = [];
      if (bc.appDescription) lines.push(`- App: ${bc.appDescription}`);
      if (bc.userType) lines.push(`- Target users: ${bc.userType}`);
      if (bc.industry) lines.push(`- Industry: ${bc.industry}`);
      if (bc.isMultiTenant !== undefined) lines.push(`- Multi-tenant: ${bc.isMultiTenant ? "yes" : "no"}`);
      if (bc.hasPaidFeatures !== undefined) lines.push(`- Paid features: ${bc.hasPaidFeatures ? "yes" : "no"}`);
      if (lines.length > 0) {
        parts.push("## Business Context", lines.join("\n"));
      }
    }

    return parts.join("\n\n");
  }

  private relevantFiles(agentType: AgentTaskType): string[] {
    const byType: Record<AgentTaskType, string[]> = {
      planning:   ["CONTRACT.md", "DB_SCHEMA.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      frontend:   ["DESIGN_TOKENS.md", "MEMORY_RULES.md", "CONTRACT.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      backend:    ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      db:         ["CONTRACT.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      security:   ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      connection: ["CONTRACT.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      fix:        ["CONTRACT.md", "CURRENT_STATE.md"],
      deploy:     ["CONTRACT.md", "CURRENT_STATE.md"],
      monitor:    ["CONTRACT.md", "CURRENT_STATE.md"],
    };
    return [...new Set(byType[agentType] ?? ["CONTRACT.md"])];
  }

  private async readFileFrom(dir: string, filename: string): Promise<string | null> {
    const filepath = join(dir, filename);
    try {
      const content = await readFile(filepath, "utf8");
      return content.trim();
    } catch {
      return null;
    }
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    // Trim to the last complete line to avoid mid-sentence cuts
    const lastNewline = truncated.lastIndexOf("\n");
    return (lastNewline > maxChars * 0.8 ? truncated.slice(0, lastNewline) : truncated) +
      "\n\n[Context truncated to fit token budget]";
  }

  private async loadRelevantSkills(
    prompt: string,
    buildType?: "frontend" | "fullstack",
  ): Promise<string> {
    return loadSkillsForPrompt(prompt, buildType ? { buildType } : undefined);
  }
}
