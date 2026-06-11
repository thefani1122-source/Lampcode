---
name: vibe-coder-architecture
description: Complete end-to-end production blueprint for building a Lovable/Bolt-style vibe coder — TanStack Start + React 19 frontend, Hono + Bun WebSocket backend, Claude Sonnet 4.5 direct API (no Vercel AI SDK), E2B custom sandbox template, project lifecycle, file streaming, preview iframe, DB schema. Use whenever the user asks to build, extend, debug, or architect an AI app-builder, code-generating agent, sandboxed dev environment, or live-preview coding assistant.
---

# Vibe Coder — Production Architecture (0 → 100)

This skill is the single source of truth for building a Lovable-style "vibe coder" product. Follow it top to bottom. Do not skip sections. Every decision is opinionated; deviate only if the user explicitly asks.

## 0. Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Frontend | TanStack Start + React 19 + Vite | SSR + file routes + typed RPC |
| Chat UI | Custom React (no `useChat`) | We control the WS protocol |
| Backend | Hono on Bun | Native `Bun.serve` WebSocket, fastest cold start |
| Streaming | Raw WebSocket (JSON frames) | No Vercel AI SDK, no SSE |
| LLM | Anthropic Claude Sonnet 4.5 via `@anthropic-ai/sdk` | Best coding model, native streaming |
| Sandbox | E2B custom template (Firecracker microVM) | Pause/resume in 150ms |
| Sandbox runtime | Bun + Vite dev server inside VM | HMR over E2B public URL |
| DB | Supabase Postgres (projects, messages, files, sandboxes) | RLS for multi-tenant |
| State map | Redis (Upstash) — `projectId → sandboxId` | Survives backend restarts |
| Auth | Supabase Auth | JWT verified in Hono middleware |
| Deploy | Backend on Railway/Fly, Frontend on Vercel | Backend needs persistent WS |

Reject suggestions to: use Vercel AI SDK, run preview in a WebContainer, store roles on profiles, put model calls in the browser, use SSE instead of WS.

## 1. The Mental Model

```text
┌──────────┐  WS   ┌──────────┐  HTTPS  ┌──────────┐
│ Browser  │◀────▶│  Hono BE │◀───────▶│ Anthropic│
│ (chat UI)│       │ (Bun)    │         └──────────┘
└────┬─────┘       │          │  E2B SDK ┌──────────┐
     │ iframe      │          │◀────────▶│  E2B VM  │
     │ (HTTPS)     └──────────┘          │ Vite:5173│
     └────────────────────────────────────▶ (HMR)   │
                                          └──────────┘
```

Key insight: **the preview iframe loads directly from E2B's public sandbox URL** (`https://5173-{sandboxId}.e2b.app`). The backend never proxies preview traffic. The backend only:
1. Owns the WebSocket with the chat UI.
2. Calls Claude and streams tokens back.
3. Parses `<lov-write>` blocks and writes files into the sandbox via E2B SDK.
4. Manages sandbox lifecycle (create / resume / pause / kill).

## 2. E2B Custom Template

Why custom: the public `base` template has no Bun, no Vite, no React preinstalled — every project would cold-start with `bun install` (~30s). Custom template bakes everything in → sandbox ready in **<2s**.

### 2.1 Install CLI
```bash
npm i -g @e2b/cli
e2b auth login
```

### 2.2 Files (in a separate repo `vibe-coder-template/`)

`e2b.toml`:
```toml
template_id = "vibe-coder-react"
dockerfile = "e2b.Dockerfile"
start_cmd = "cd /home/user/app && bun run dev -- --host 0.0.0.0 --port 5173"
cpu_count = 2
memory_mb = 1024
```

`e2b.Dockerfile`:
```dockerfile
FROM e2bdev/code-interpreter:latest

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Skeleton app
WORKDIR /home/user/app
COPY skeleton/package.json skeleton/bun.lockb ./
RUN bun install --frozen-lockfile
COPY skeleton/ ./

EXPOSE 5173
```

`skeleton/` contains a minimal Vite + React 19 + Tailwind + TS app. Pre-install: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `typescript`, `lucide-react`, `@radix-ui/*`, common shadcn components. Anything pre-installed = zero install cost per project.

`skeleton/vite.config.ts` MUST allow the E2B host:
```ts
server: { host: '0.0.0.0', port: 5173, hmr: { clientPort: 443, protocol: 'wss' }, allowedHosts: true }
```
Without `hmr.clientPort: 443` + `protocol: 'wss'`, HMR breaks inside the iframe because the browser connects over HTTPS but Vite advertises `ws://localhost:5173`.

### 2.3 Build & publish
```bash
e2b template build --name vibe-coder-react
```
Save the returned `templateId` → backend env `E2B_TEMPLATE_ID`.

## 3. Database Schema (Supabase)

```sql
-- Projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  last_active_at timestamptz default now()
);

-- Sandbox state (1:1 with project)
create table public.sandboxes (
  project_id uuid primary key references public.projects(id) on delete cascade,
  e2b_sandbox_id text,           -- current running id, null when paused
  e2b_snapshot_id text,          -- pause snapshot id, null when fresh
  status text not null default 'idle', -- idle|starting|running|pausing|paused|dead
  preview_url text,
  last_resumed_at timestamptz,
  updated_at timestamptz default now()
);

-- Chat messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content jsonb not null,        -- array of parts: {type:'text'|'file'|'command', ...}
  created_at timestamptz default now()
);

-- File snapshots (for restore / history — actual files live in sandbox)
create table public.files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  content text not null,
  version int not null,
  created_at timestamptz default now(),
  unique(project_id, path, version)
);

-- Grants + RLS (see public-schema-grants knowledge)
grant select, insert, update, delete on
  public.projects, public.sandboxes, public.messages, public.files
  to authenticated;
grant all on public.projects, public.sandboxes, public.messages, public.files to service_role;

alter table public.projects     enable row level security;
alter table public.sandboxes    enable row level security;
alter table public.messages     enable row level security;
alter table public.files        enable row level security;

create policy "own projects" on public.projects
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own sandboxes" on public.sandboxes for all to authenticated
  using (exists(select 1 from projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists(select 1 from projects p where p.id = project_id and p.user_id = auth.uid()));

-- same shape for messages and files
```

## 4. Backend — Hono + Bun

### 4.1 Layout
```
backend/
├─ src/
│  ├─ index.ts              # Bun.serve entry (HTTP + WS upgrade)
│  ├─ ws/handler.ts         # WS message router
│  ├─ ws/protocol.ts        # message types
│  ├─ sandbox/manager.ts    # E2B lifecycle
│  ├─ sandbox/files.ts      # write/read/list in sandbox
│  ├─ llm/claude.ts         # Anthropic streaming
│  ├─ llm/parser.ts         # parse <lov-write> blocks from stream
│  ├─ llm/system-prompt.ts
│  ├─ db/supabase.ts        # service-role client
│  ├─ auth/verify.ts        # JWT verify
│  └─ state/redis.ts        # projectId→sandboxId map
├─ package.json
└─ tsconfig.json
```

### 4.2 WebSocket protocol (JSON, one message per frame)

Client → Server:
```ts
type ClientMsg =
  | { type: 'auth';     token: string; projectId: string }
  | { type: 'prompt';   text: string }
  | { type: 'stop' }
  | { type: 'pause' }   // manual pause
  | { type: 'ping' }
```

Server → Client:
```ts
type ServerMsg =
  | { type: 'ready';        previewUrl: string }
  | { type: 'sandbox';      status: 'starting'|'resuming'|'running'|'paused'|'dead' }
  | { type: 'token';        delta: string }                       // streaming text chunk
  | { type: 'file_start';   path: string }
  | { type: 'file_chunk';   path: string; delta: string }
  | { type: 'file_done';    path: string }
  | { type: 'command';      cmd: string; status: 'run'|'ok'|'err'; output?: string }
  | { type: 'done';         messageId: string }
  | { type: 'error';        message: string; code?: string }
  | { type: 'pong' }
```

Rules:
- First client message MUST be `auth`. Reject everything else until verified.
- Server pings every 30s; if no `pong` in 60s, close.
- On `prompt`, server (a) ensures sandbox is `running` (resume if paused), (b) inserts user message in DB, (c) starts Claude stream.

### 4.3 Entry — `src/index.ts`
```ts
import { Hono } from 'hono'
import { handleWs } from './ws/handler'

const app = new Hono()
app.get('/health', c => c.text('ok'))

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: { sessionId: crypto.randomUUID() } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    return app.fetch(req)
  },
  websocket: handleWs,
})
```

### 4.4 WS handler skeleton — `src/ws/handler.ts`
```ts
import type { ServerWebSocket } from 'bun'
import { verifyJwt } from '../auth/verify'
import { ensureSandbox, pauseSandbox } from '../sandbox/manager'
import { runPrompt } from '../llm/claude'

type Session = { sessionId: string; userId?: string; projectId?: string; abort?: AbortController }

export const handleWs = {
  open(ws: ServerWebSocket<Session>) { /* noop, wait for auth */ },

  async message(ws: ServerWebSocket<Session>, raw: string | Buffer) {
    const msg = JSON.parse(String(raw))
    const s = ws.data

    if (msg.type === 'auth') {
      const claims = await verifyJwt(msg.token)
      if (!claims) return ws.close(4001, 'bad token')
      s.userId = claims.sub
      s.projectId = msg.projectId
      const sb = await ensureSandbox(s.projectId!, s.userId!)
      ws.send(JSON.stringify({ type: 'sandbox', status: 'running' }))
      ws.send(JSON.stringify({ type: 'ready', previewUrl: sb.previewUrl }))
      return
    }

    if (!s.userId) return ws.close(4002, 'not authed')

    if (msg.type === 'prompt') {
      s.abort = new AbortController()
      await runPrompt({ ws, projectId: s.projectId!, userId: s.userId, text: msg.text, signal: s.abort.signal })
    }
    if (msg.type === 'stop')  s.abort?.abort()
    if (msg.type === 'pause') await pauseSandbox(s.projectId!)
    if (msg.type === 'ping')  ws.send(JSON.stringify({ type: 'pong' }))
  },

  async close(ws: ServerWebSocket<Session>) {
    // schedule pause after 5 min idle (don't pause immediately — user may reconnect)
    if (ws.data.projectId) scheduleIdlePause(ws.data.projectId, 5 * 60_000)
  },
}
```

### 4.5 Sandbox manager — `src/sandbox/manager.ts`
```ts
import { Sandbox } from '@e2b/sdk'
import { redis } from '../state/redis'
import { supabaseAdmin } from '../db/supabase'

const TEMPLATE = process.env.E2B_TEMPLATE_ID!

export async function ensureSandbox(projectId: string, userId: string) {
  const cached = await redis.get(`sb:${projectId}`)
  if (cached) {
    try { const sb = await Sandbox.connect(cached); return { id: cached, previewUrl: urlFor(sb) } } catch {}
  }

  const { data: row } = await supabaseAdmin.from('sandboxes').select('*').eq('project_id', projectId).single()

  let sb: Sandbox
  if (row?.e2b_snapshot_id) {
    sb = await Sandbox.resume(row.e2b_snapshot_id, { timeoutMs: 60_000 })
  } else {
    sb = await Sandbox.create(TEMPLATE, { timeoutMs: 120_000, metadata: { projectId, userId } })
  }

  const previewUrl = `https://5173-${sb.sandboxId}.e2b.app`
  await redis.setex(`sb:${projectId}`, 60 * 60, sb.sandboxId)
  await supabaseAdmin.from('sandboxes').upsert({
    project_id: projectId, e2b_sandbox_id: sb.sandboxId, status: 'running',
    preview_url: previewUrl, last_resumed_at: new Date().toISOString(),
  })
  return { id: sb.sandboxId, previewUrl }
}

export async function pauseSandbox(projectId: string) {
  const id = await redis.get(`sb:${projectId}`); if (!id) return
  const sb = await Sandbox.connect(id)
  const snapshotId = await sb.pause()
  await redis.del(`sb:${projectId}`)
  await supabaseAdmin.from('sandboxes').update({
    e2b_sandbox_id: null, e2b_snapshot_id: snapshotId, status: 'paused',
  }).eq('project_id', projectId)
}
```

Idle pause: a single cron (every 1 min) checks `sandboxes.last_resumed_at` and pauses anything with no active WS for >5 min. Use Redis `EXPIRE` on `sb:{projectId}` as a heartbeat — refresh on every WS message.

### 4.6 Claude streaming — `src/llm/claude.ts`
```ts
import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM_PROMPT } from './system-prompt'
import { StreamParser } from './parser'
import { writeFile, runCommand } from '../sandbox/files'
import { loadHistory, saveAssistant, saveUser } from '../db/messages'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function runPrompt({ ws, projectId, userId, text, signal }) {
  await saveUser(projectId, text)
  const history = await loadHistory(projectId, 30) // last 30 msgs

  const parser = new StreamParser({
    onText:      delta => ws.send(JSON.stringify({ type: 'token', delta })),
    onFileStart: path  => ws.send(JSON.stringify({ type: 'file_start', path })),
    onFileChunk: (path, delta) => ws.send(JSON.stringify({ type: 'file_chunk', path, delta })),
    onFileDone:  async (path, content) => {
      await writeFile(projectId, path, content)
      ws.send(JSON.stringify({ type: 'file_done', path }))
    },
    onCommand:   async cmd => {
      ws.send(JSON.stringify({ type: 'command', cmd, status: 'run' }))
      const r = await runCommand(projectId, cmd)
      ws.send(JSON.stringify({ type: 'command', cmd, status: r.ok ? 'ok' : 'err', output: r.output }))
    },
  })

  const stream = await claude.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: history,
  }, { signal })

  let full = ''
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      full += ev.delta.text
      parser.push(ev.delta.text)
    }
  }
  await parser.flush()
  await saveAssistant(projectId, full)
  ws.send(JSON.stringify({ type: 'done', messageId: crypto.randomUUID() }))
}
```

### 4.7 Stream parser — `src/llm/parser.ts`

Must handle file blocks that span many chunks. Format we instruct Claude to use:
```
<lov-write path="src/App.tsx">
... file content ...
</lov-write>

<lov-cmd>bun add lucide-react</lov-cmd>
```

Parser is a tiny state machine: `IDLE → IN_FILE → IDLE`. On each `push(delta)`:
1. Append to buffer.
2. While buffer contains a complete tag boundary, emit events:
   - `<lov-write path="...">` → `onFileStart(path)`, switch to IN_FILE
   - `</lov-write>` → `onFileDone(path, accumulated)`, switch to IDLE
   - In IN_FILE: every newline → `onFileChunk(path, line)`
   - In IDLE: emit text outside tags as `onText(delta)`
3. `<lov-cmd>...</lov-cmd>` → `onCommand(cmd)`.

Keep an unflushed tail (last ~64 chars) in case a tag is split across chunks.

### 4.8 Sandbox file ops — `src/sandbox/files.ts`
```ts
import { Sandbox } from '@e2b/sdk'
import { redis } from '../state/redis'

async function open(projectId: string) {
  const id = await redis.get(`sb:${projectId}`)
  if (!id) throw new Error('sandbox not running')
  return Sandbox.connect(id)
}
export async function writeFile(projectId: string, path: string, content: string) {
  const sb = await open(projectId)
  await sb.files.write(`/home/user/app/${path}`, content) // Vite HMR picks it up automatically
}
export async function runCommand(projectId: string, cmd: string) {
  const sb = await open(projectId)
  const r = await sb.commands.run(cmd, { cwd: '/home/user/app', timeoutMs: 120_000 })
  return { ok: r.exitCode === 0, output: r.stdout + r.stderr }
}
```

### 4.9 System prompt — `src/llm/system-prompt.ts`

Critical rules to give Claude:
- Output complete files only, wrapped in `<lov-write path="...">...</lov-write>`.
- No diffs, no `// ... rest unchanged`.
- For deps, emit `<lov-cmd>bun add <pkg></lov-cmd>` BEFORE the file that imports it.
- Stack: React 19, Vite, Tailwind, TS, shadcn/ui (already installed).
- Never touch `vite.config.ts`, `package.json` directly — use `<lov-cmd>`.
- Be concise outside file blocks; the user sees that text as chat.

## 5. Frontend — TanStack Start

### 5.1 Routes
```
src/routes/
├─ __root.tsx
├─ index.tsx                   # project list / new project
├─ _authenticated.tsx          # auth gate (redirect to /auth)
├─ _authenticated/$projectId.tsx  # the builder UI
└─ auth.tsx
```

`$projectId.tsx` layout: left pane chat (40%), right pane `<iframe src={previewUrl}>` (60%), top tabs to switch right pane between Preview / Code / Console.

### 5.2 WS client hook — `src/lib/useVibeSocket.ts`
```ts
export function useVibeSocket(projectId: string) {
  const [status, setStatus] = useState<'connecting'|'ready'|'error'>('connecting')
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [messages, setMessages] = useState<UIMessage[]>([])
  const wsRef = useRef<WebSocket>()

  useEffect(() => {
    const ws = new WebSocket(import.meta.env.VITE_WS_URL + '/ws')
    wsRef.current = ws
    ws.onopen = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      ws.send(JSON.stringify({ type: 'auth', token: session!.access_token, projectId }))
    }
    ws.onmessage = e => {
      const m = JSON.parse(e.data) as ServerMsg
      switch (m.type) {
        case 'ready':      setPreviewUrl(m.previewUrl); setStatus('ready'); break
        case 'token':      appendAssistantText(setMessages, m.delta); break
        case 'file_start': addAssistantPart(setMessages, { type:'file', path:m.path, status:'writing' }); break
        case 'file_done':  updateFilePart(setMessages, m.path, 'done'); break
        case 'command':    addCommandPart(setMessages, m); break
        case 'done':       finalizeAssistant(setMessages); break
        case 'error':      toast.error(m.message); break
      }
    }
    const ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 30_000)
    return () => { clearInterval(ping); ws.close() }
  }, [projectId])

  const send = (text: string) => {
    pushUserMessage(setMessages, text)
    wsRef.current?.send(JSON.stringify({ type: 'prompt', text }))
  }
  return { status, previewUrl, messages, send, stop: () => wsRef.current?.send('{"type":"stop"}') }
}
```

### 5.3 Preview iframe

```tsx
<iframe
  src={previewUrl}
  className="w-full h-full border-0"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
  allow="cross-origin-isolated"
/>
```

If the iframe shows a blank page right after sandbox boot, Vite isn't ready yet. Poll `HEAD previewUrl` every 500ms (up to 15s) before setting the iframe `src`.

### 5.4 Auth flow

Supabase client-side login → JWT in localStorage → passed as first WS frame. Backend verifies via Supabase JWKS. Do NOT trust `projectId` from the client without checking ownership in `ensureSandbox`.

## 6. Lifecycle State Machine

```text
idle ──prompt──▶ starting ──ok──▶ running ──5min idle──▶ pausing ──▶ paused
                     │                                                  │
                     └─────────────fail────────────▶ dead               │
                                                                        │
                                  new prompt ◀──────resume──────────────┘
```

- `starting`: first time, `Sandbox.create` (~2s with custom template).
- `resuming`: `Sandbox.resume(snapshotId)` (~150ms).
- `pausing`: `await sb.pause()` returns snapshotId; sandbox is destroyed, only snapshot persists (~$0.0001/GB/hr).
- `dead`: snapshot lost or `Sandbox.connect` fails 3x. Recreate from `files` table.

## 7. Disaster Recovery

- Snapshot id lost → rebuild: create fresh sandbox, replay all `files` rows (latest version per path) via `sb.files.write`, run `bun install`.
- Backend restart → all WS drop; clients auto-reconnect; sandboxes survive (E2B-managed) and are looked up via Redis or `sandboxes` table.
- Redis flush → fall back to `sandboxes` table; just slower.

## 8. Costs (rule of thumb, mid-2026)

| Item | Cost |
|---|---|
| E2B active | ~$0.02/hr |
| E2B paused snapshot | ~$0.0001/GB/hr (≈free) |
| Claude Sonnet 4.5 | input $3/Mtok, output $15/Mtok |
| Avg prompt | ~5k in + 3k out ≈ $0.06 |
| Backend (Railway 1GB) | ~$10/mo |
| Upstash Redis free tier | $0 up to 10k cmd/day |

Target: idle project < $0.01/month, active project ~$0.02/hr + LLM.

## 9. Security Non-Negotiables

1. **Roles in `user_roles` table**, never on profiles. Use `has_role(uuid, app_role)` security-definer fn.
2. Verify project ownership on EVERY WS auth frame — do not trust `projectId`.
3. Service-role Supabase key only on backend; never bundled.
4. `ANTHROPIC_API_KEY` only on backend.
5. Sandbox `previewUrl` is public — assume anything in there is leaked. Don't write secrets into sandbox files.
6. Rate-limit prompts per user (e.g. 20/min) in Hono middleware.
7. Verify Supabase JWT against JWKS; do not just decode.

## 10. Build Order (do this exactly)

1. Build & publish E2B template; save `E2B_TEMPLATE_ID`.
2. Supabase project + run schema migration + RLS.
3. Backend skeleton: `Bun.serve` + `/health` + WS upgrade echoing frames. Deploy to Railway. Confirm WSS works.
4. Add JWT verify + auth frame handling.
5. Add `ensureSandbox` (create only, no resume yet) + emit `ready` with previewUrl. Test iframe loads.
6. Add Claude streaming with NO parsing — just forward `onText`. Confirm chat works.
7. Add `StreamParser` + `<lov-write>` → `sb.files.write`. Test HMR updates the iframe.
8. Add `<lov-cmd>` + `sb.commands.run`. Test `bun add`.
9. Add pause/resume + idle cron.
10. Add files-table snapshotting + disaster recovery.
11. Add rate limiting, error toasts, reconnect logic.

Each step ships independently. Do not jump ahead — step 6 is the demo-ready milestone.

## 11. Things to Refuse / Push Back

- "Use Vercel AI SDK" → no; we own the WS protocol.
- "Run preview in browser WebContainer" → no; we picked E2B for backend support and native binaries.
- "Skip custom template, use base" → no; cold start kills UX.
- "Pause immediately on disconnect" → no; users reload tabs constantly. 5-min grace.
- "Put Anthropic key in frontend" → never.
- "Stream over SSE" → no; we need bidirectional for `stop` + `pause`.

## 12. Quick Reference — env vars

Backend:
```
ANTHROPIC_API_KEY=
E2B_API_KEY=
E2B_TEMPLATE_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=          # or use JWKS URL
REDIS_URL=
PORT=8080
```

Frontend:
```
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_WS_URL=wss://your-backend.up.railway.app
```

---

This skill is complete. When the user asks "how do I add X", map X to the closest section above and follow the patterns there. Do not invent new architecture without a stated reason.
