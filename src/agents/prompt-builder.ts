import { readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { type AgentTaskType } from "./model-gateway.js";
interface BuildContext {
  projectId: string;
  userId: string;
  mode: "fast" | "plan";
  prompt: string;
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
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
  estimatedInputTokens: number;
}

// ── System prompts per agent type ─────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentTaskType, string> = {
  planning: `You are the BuildForge Architect. You produce comprehensive technical plans for software projects.
Analyze the requirements, break down work into phases, identify risks, and produce a structured plan.
Your output must include: architecture overview, component breakdown, data flow, API boundaries, and risk assessment.`,

  frontend: `You are an expert frontend developer. Build complete, polished, production-ready apps.

DESIGN RULES:
- Choose colors that MATCH the app's purpose and mood
  (fitness app = energetic oranges/reds,
   finance = professional blues/greens,
   creative tool = vibrant purples,
   restaurant = warm reds/oranges,
   medical = clean whites/teals)
- NO hardcoded ugly colors: avoid #333, #666, gray, lightgray
- NO neon colors unless explicitly requested
- Colors must feel intentional and professional
- Each app should have its OWN unique visual identity

CODE RULES — NON-NEGOTIABLE:
- ALL buttons must do something (reactive state logic)
- ALL navigation links must show different content (conditional rendering)
- NO placeholder "coming soon" sections
- NO broken or dead UI elements
- Complete realistic mock data (not "Item 1", "User Name")
- Working forms with validation feedback
- Smooth CSS transitions on hover/click

DESIGN SYSTEM — REQUIRED:
If a "DESIGN_TOKENS.md" section appears in the context, those are the persisted CSS variables for this project.
You MUST use ONLY those variables for colors, backgrounds, and spacing — do NOT introduce new hex colors.
Use: var(--primary), var(--background), var(--card), var(--text), etc.
If a variable you need is missing, ADD it to the :root block following the existing naming pattern.
NEVER use hardcoded hex values (#xxx), rgb(), or hsl() for anything already covered by the design tokens.

MEMORY RULES — REQUIRED:
If a "MEMORY_RULES.md" section appears in the context, those are permanent project preferences.
Always follow every rule listed there on every build.

CRITICAL — SCOPE AND COMPLETENESS:
Before writing any code, estimate if the full request fits in ~400 lines.
If it does NOT fit: REDUCE SCOPE. Cut features, simplify components, merge sections.
A complete 200-line app is ALWAYS better than a truncated 800-line app.
Always close every template tag or JSX element you open — NEVER leave markup unterminated.
Always include a complete root component with all state and event handlers.
If you are simplifying due to scope: add a comment at the top: // Simplified version

PLANNING — REQUIRED BEFORE CODE:
Before writing any code, explain your plan in 2-3 sentences. Describe what you will build and the key components. Only AFTER this explanation, begin writing files.

CSS BUDGET — global stylesheet must stay under 100 lines total:
- :root { } block: 10–15 CSS variables max
- Component-specific styles: use framework inline styles or scoped styles
- NO @keyframes or animation blocks unless explicitly requested
- NO media queries unless explicitly requested
- NO CSS resets, universal * selectors, or normalize rules
- One global font-family on body is fine; everything else belongs inline

QUALITY BAR:
Build as if a senior designer reviewed every pixel.
Every interaction must feel smooth and intentional.`,

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

export type Framework = "react" | "vue" | "nextjs" | "svelte" | "solid";

/**
 * Detect which frontend framework the user is requesting.
 * React is the default when no specific framework keyword is found.
 */
export function detectFramework(prompt: string): Framework {
  if (/\bvue\b/i.test(prompt)) return "vue";
  if (/\bnext\.?js\b|\bnextjs\b/i.test(prompt)) return "nextjs";
  if (/\bsvelte\b/i.test(prompt)) return "svelte";
  if (/\bsolid\.?js\b|\bsolidjs\b|\bsolid[- ]?js\b/i.test(prompt)) return "solid";
  return "react";
}

const FRAMEWORK_RULES: Record<Framework, string> = {
  react: `
FRAMEWORK: React + TypeScript

FILE FORMAT — ALWAYS in this exact order:
1. \`\`\`filename:src/App.tsx — complete component, export default function App()
2. \`\`\`filename:src/styles.css — all CSS using variables
3. \`\`\`filename:src/index.tsx — always identical render boilerplate
4. \`\`\`filename:package.json — only react + react-dom

SANDBOX RESTRICTIONS:
- Do NOT use fetch() or any HTTP requests
- Do NOT use localStorage or sessionStorage
- Do NOT import external libraries beyond react and react-dom
- All icons must be inline SVG or emoji — no icon libraries
- All data must be static mock data defined in the component`,

  vue: `
FRAMEWORK: Vue 3 + TypeScript (Composition API)

FILE FORMAT — ALWAYS in this exact order:
1. \`\`\`filename:src/App.vue — root component using <script setup lang="ts">
2. \`\`\`filename:src/style.css — all CSS using variables
3. \`\`\`filename:src/main.ts — boilerplate: import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app')
4. \`\`\`filename:index.html — Vite entry: <div id="app"></div> + <script type="module" src="/src/main.ts"></script>
5. \`\`\`filename:package.json — vue + @vitejs/plugin-vue only
6. \`\`\`filename:vite.config.ts — import { defineConfig } from 'vite'; import vue from '@vitejs/plugin-vue'; export default defineConfig({ plugins: [vue()] })

FRAMEWORK RULES:
- Always use <script setup lang="ts"> — never Options API
- Reactivity: ref() for primitives, reactive() for objects, computed() for derived values
- Event handling: @click, @input, @submit (shorthand for v-on:)
- Data binding: :propName (shorthand for v-bind:), v-model for two-way
- Conditionals/loops: v-if / v-else-if / v-else, v-for="item in items" :key="item.id"
- Child components: import directly in <script setup>, no registration needed
- Do NOT write React hooks (useState, useEffect) — Vue has its own reactivity

SANDBOX RESTRICTIONS:
- Do NOT use fetch() or any HTTP requests
- Do NOT use localStorage or sessionStorage
- Do NOT import libraries beyond vue
- All icons must be inline SVG or emoji
- All data must be static mock data defined in the component`,

  nextjs: `
FRAMEWORK: Next.js 14+ (App Router, TypeScript)

FILE FORMAT — ALWAYS in this exact order:
1. \`\`\`filename:app/page.tsx — main page (Server Component by default)
2. \`\`\`filename:app/layout.tsx — root layout with <html lang="en"><body>
3. \`\`\`filename:app/globals.css — all CSS using variables
4. \`\`\`filename:package.json — next + react + react-dom only

FRAMEWORK RULES:
- Server Components (default): no "use client" directive, can be async
- Client Components: add "use client" at the very top when using useState / useEffect / event handlers
- Prefer Server Components — only promote to Client Component when interactivity is needed
- Routing is file-based (app/about/page.tsx → /about) — do NOT use react-router
- Export page components as: export default function Page() { }
- Layout: export default function RootLayout({ children }: { children: React.ReactNode }) { }

SANDBOX RESTRICTIONS:
- Do NOT use fetch() or external APIs — all data must be static
- Do NOT use localStorage or sessionStorage
- Do NOT generate app/api/ routes — static/client data only for preview
- All icons must be inline SVG or emoji
- All data must be static mock data defined in the component`,

  svelte: `
FRAMEWORK: Svelte 4 + TypeScript + Vite

FILE FORMAT — ALWAYS in this exact order:
1. \`\`\`filename:src/App.svelte — root component
2. \`\`\`filename:src/app.css — all CSS using variables
3. \`\`\`filename:src/main.ts — boilerplate: import './app.css'; import App from './App.svelte'; const app = new App({ target: document.body }); export default app;
4. \`\`\`filename:index.html — Vite entry: <script type="module" src="/src/main.ts"></script>
5. \`\`\`filename:package.json — svelte + @sveltejs/vite-plugin-svelte only
6. \`\`\`filename:vite.config.ts — import { defineConfig } from 'vite'; import { svelte } from '@sveltejs/vite-plugin-svelte'; export default defineConfig({ plugins: [svelte()] })

FRAMEWORK RULES:
- Script block: <script lang="ts"> at the top of every .svelte file
- Reactive state: let count = 0; (all let variables are reactive)
- Reactive statements: $: doubled = count * 2
- Event handling: on:click={handler}, on:input={handler}
- Two-way binding: bind:value={name}
- Conditionals: {#if condition} ... {:else} ... {/if}
- Loops: {#each items as item (item.id)} ... {/each}
- Do NOT write React/Vue patterns — Svelte reactivity is different

SANDBOX RESTRICTIONS:
- Do NOT use fetch() or any HTTP requests
- Do NOT use localStorage or sessionStorage
- Do NOT import libraries beyond svelte
- All icons must be inline SVG or emoji
- All data must be static mock data defined in the component`,

  solid: `
FRAMEWORK: SolidJS + TypeScript + Vite

FILE FORMAT — ALWAYS in this exact order:
1. \`\`\`filename:src/App.tsx — root component, export default function App()
2. \`\`\`filename:src/index.css — all CSS using variables
3. \`\`\`filename:src/index.tsx — boilerplate: import { render } from 'solid-js/web'; import App from './App'; render(() => <App />, document.getElementById('root')!)
4. \`\`\`filename:package.json — solid-js + vite-plugin-solid only
5. \`\`\`filename:vite.config.ts — import { defineConfig } from 'vite'; import solid from 'vite-plugin-solid'; export default defineConfig({ plugins: [solid()] })

FRAMEWORK RULES:
- State: const [count, setCount] = createSignal(0); read as count() — always call the accessor
- Derived: const doubled = createMemo(() => count() * 2)
- Effects: createEffect(() => { console.log(count()); })
- Conditional rendering: <Show when={condition()}><Child /></Show>
- List rendering: <For each={items()}>{(item) => <div>{item.name}</div>}</For>
- Do NOT use React hooks (useState, useEffect) — SolidJS has fundamentally different semantics
- Components render ONCE; reactivity is at the signal level, not component re-render

SANDBOX RESTRICTIONS:
- Do NOT use fetch() or any HTTP requests
- Do NOT use localStorage or sessionStorage
- Do NOT import libraries beyond solid-js
- All icons must be inline SVG or emoji
- All data must be static mock data defined in the component`,
};

// ── Fullstack mode instruction ────────────────────────────────────────────────
// Appended to the frontend system prompt when the task is a full-stack build.
// Detected by the "FULLSTACK BUILD:" description prefix set in build.ts.

const FULLSTACK_INSTRUCTION = `

FULLSTACK MODE — You are building a complete full-stack application (frontend + backend + database).

WEBCONTAINER CONSTRAINT — NON-NEGOTIABLE:
- Backend: Node.js / TypeScript ONLY. Do NOT generate Python, PHP, Ruby, Go, Rust, Java, or any non-Node runtime.
- Framework: Hono.js (preferred), Express.js, or Fastify. Never Django, Flask, FastAPI, Laravel, Rails, etc.
- Database: Use an EXTERNAL cloud database via its SDK — Supabase (@supabase/supabase-js) is the default.
  WebContainers CANNOT run a local PostgreSQL/MySQL/Redis server process. Never import or use Drizzle ORM,
  pg, mysql2, or any driver that opens a raw TCP socket to a database.
- Auth: Supabase Auth or JWT — never native Passport.js, bcrypt-native, or OS-level session stores.
- NO native C++ modules — every npm package must be pure JavaScript/TypeScript or WebAssembly.

FRONTEND RULES:
- Use React + TypeScript.
- ALL data fetching goes through functions exported from src/lib/api.ts.
- Load data with useEffect + useState; always show loading and error states.
- fetch() IS allowed, but ONLY inside src/lib/api.ts (this overrides the no-fetch sandbox rule).

BACKEND RULES:
- Use Hono.js for API routes.
- Use the Supabase JS client for all database access (supabase.from('table').select/insert/update/delete).
- Export the router as: export const api = new Hono()
- Prefix every route with /api/.
- Add permissive CORS headers.
- Validate every request body with Zod.
- The server-side Supabase client uses process.env.SUPABASE_URL + process.env.SUPABASE_SERVICE_KEY.

DATABASE RULES:
- Use @supabase/supabase-js — NOT drizzle-orm, NOT the postgres package, NOT any TCP DB driver.
- Define TypeScript interfaces for each table's row type in src/db/types.ts.
- Generate CREATE TABLE SQL for Supabase in src/db/schema.sql (plain SQL, not executed by the app —
  user runs it once in the Supabase SQL editor or dashboard).
- Include created_at TIMESTAMPTZ DEFAULT now() on every table.
- Use appropriate column types: UUID, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ.

FILE FORMAT — generate EXACTLY these files, in this order, each in its own \`\`\`filename: fence:

BACKEND FILES (always the same regardless of frontend framework):
1. \`\`\`filename:src/db/types.ts          — TypeScript interfaces for each Supabase table row
2. \`\`\`filename:src/db/schema.sql        — CREATE TABLE SQL to run once in Supabase dashboard
3. \`\`\`filename:src/server/routes/api.ts — Hono CRUD routes using supabase.from(...) (export const api = new Hono())
4. \`\`\`filename:src/lib/api.ts           — typed frontend fetch wrappers that call /api/...

FRONTEND FILES (adapt to the framework detected in the section above):
- React (default): src/App.tsx, src/styles.css, src/index.tsx
- Vue:    src/App.vue, src/style.css, src/main.ts, index.html, vite.config.ts
- Next.js: app/page.tsx, app/layout.tsx, app/globals.css
- Svelte: src/App.svelte, src/app.css, src/main.ts, index.html, vite.config.ts
- SolidJS: src/App.tsx, src/index.css, src/index.tsx, vite.config.ts

PACKAGE.JSON:
Include BOTH the frontend framework deps AND: hono, @supabase/supabase-js, zod
Scripts must be EXACTLY:
   {
     "scripts": {
       "dev": "vite",
       "build": "vite build"
     }
   }
(Next.js exception: "dev": "next dev", "build": "next build")
"server" and "db:seed" scripts must NOT be included — Sandpack runs only "dev".

ENV EXAMPLE:
\`\`\`filename:.env.example
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_KEY=your_service_role_key
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_anon_key
VITE_API_URL=http://localhost:5173
\`\`\`

BACKEND INTEGRATION EXAMPLE (same for all frameworks):
In src/server/routes/api.ts:
  import { createClient } from '@supabase/supabase-js'
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
  api.get('/todos', async (c) => {
    const { data, error } = await supabase.from('todos').select('*')
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  })

FRONTEND DATA FETCHING — adapt the import but the pattern is the same:
  import { fetchTodos, createTodo } from './lib/api'
  // React: useEffect + useState
  // Vue: onMounted + ref
  // Svelte: onMount + let variable
  // SolidJS: createResource or onMount + createSignal
  // Next.js: async server component or useEffect in client component

Skip src/server/auth.ts entirely if the app has no login/account concept.`;

// ── Auth sub-mode instruction ─────────────────────────────────────────────────
// Appended after FULLSTACK_INSTRUCTION when the task prefix is "FULLSTACK AUTH BUILD:".

const FULLSTACK_AUTH_INSTRUCTION = `

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
    - Two tabs: "Sign In" | "Sign Up" — switching between them changes the form
    - Email + password fields (controlled inputs) for both Sign In and Sign Up
    - "Continue with Google" button with Google's red (#DB4437) color
    - "Continue with GitHub" button with GitHub's dark (#24292e) color
    - Both OAuth buttons call the matching method from useAuthContext()
    - Error message display (red text, below the form)
    - Loading state: disable buttons and show "Loading..." during async calls
    - Clean card layout, centered on screen, white background, subtle box-shadow
    - Export default Login

15. \`\`\`filename:.env.example
    Use this EXACT content (overrides the base .env.example):
    \`\`\`
    VITE_SUPABASE_URL=your_supabase_url
    VITE_SUPABASE_ANON_KEY=your_anon_key
    VITE_API_URL=http://localhost:5173
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

PACKAGE.JSON — add @supabase/supabase-js to the dependencies object:
    "@supabase/supabase-js": "^2.39.0"

APP.TSX — integrate auth into the main app:
- Import AuthProvider from './components/AuthProvider'
- Import Login from './components/Login'
- Import useAuthContext from './components/AuthProvider'
- The root return must wrap everything in <AuthProvider>
- Inside, use a guard: if (user === null) return <Login />
- When authenticated: render the full app UI with a sign-out button in the header
- Example skeleton:
    function AuthenticatedApp() {
      const { user, signOut } = useAuthContext();
      return (
        <div>
          <header>
            <span>{user?.email}</span>
            <button onClick={signOut}>Sign out</button>
          </header>
          {/* rest of app */}
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
    function AppContent() {
      const { user, loading } = useAuthContext();
      if (loading) return <div>Loading...</div>;
      if (!user) return <Login />;
      return <AuthenticatedApp />;
    }`;

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
    const systemPrompt = this.buildSystemPrompt(agentType, task);
    const contextBlock = await this.buildContextBlock(agentType, workspaceDir, contextFiles);
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

    // ── Framework detection (frontend agent only) ──────────────────────────
    const framework = agentType === "frontend"
      ? detectFramework(task.description)
      : "react";
    const frameworkInstruction = agentType === "frontend"
      ? FRAMEWORK_RULES[framework]
      : "";

    const isFullstackMode =
      agentType === "frontend" &&
      (task.description.startsWith("FULLSTACK BUILD:") ||
       task.description.startsWith("FULLSTACK AUTH BUILD:"));
    const fullstackInstruction = isFullstackMode ? FULLSTACK_INSTRUCTION : "";

    const isFullstackAuthMode =
      agentType === "frontend" &&
      task.description.startsWith("FULLSTACK AUTH BUILD:");
    const authInstruction = isFullstackAuthMode ? FULLSTACK_AUTH_INSTRUCTION : "";

    const isEditMode =
      agentType === "frontend" &&
      task.description.startsWith("EXISTING PROJECT FILES:");
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

    return base + frameworkInstruction + fullstackInstruction + authInstruction + editModeInstruction + jsonInstruction;
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
}
