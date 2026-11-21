import 'dotenv/config'
import { Sandbox } from 'e2b'

const TOOLS_DIR = '/home/user/.lampcode-tools'
const TOOLS_ENV = `PLAYWRIGHT_BROWSERS_PATH=${TOOLS_DIR}/browsers`
const PROJECT_DIR = '/home/user/app'
const EXPECT_UBUNTU = process.env['E2B_EXPECT_UBUNTU'] === 'true'
const FRAMEWORK = process.env['E2B_EXPECT_FRAMEWORK'] ?? 'vite'
const TEMPLATE = process.env['E2B_VERIFY_TEMPLATE_ID'] ?? process.env['E2B_TEMPLATE_ID'] ?? 'lampcode-vite'
const CANDIDATE_RE = /^lampcode-(?:vite|nextjs)-ubuntu24(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const PORT = FRAMEWORK === 'nextjs' ? 3000 : 5173
const ENTRY_CHECK = FRAMEWORK === 'nextjs'
  ? 'test -f app/layout.tsx && test -f app/page.tsx && test -f postcss.config.mjs && grep -q \"next\" package.json'
  : 'test -f src/App.tsx && test -f vite.config.ts && test -f index.html && grep -q \"vite\" package.json'

let failures = 0
function report(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  if (!process.env['E2B_API_KEY']) throw new Error('E2B_API_KEY missing. Use the gitignored e2b-template/.env file.')
  if (FRAMEWORK !== 'vite' && FRAMEWORK !== 'nextjs') throw new Error('E2B_EXPECT_FRAMEWORK must be vite or nextjs.')
  if (EXPECT_UBUNTU && !CANDIDATE_RE.test(TEMPLATE)) throw new Error(`Refusing to validate non-candidate image "${TEMPLATE}" as Ubuntu 24.04.`)
  if (FRAMEWORK === 'nextjs' && !TEMPLATE.includes('nextjs')) throw new Error('Next.js verification requires a lampcode-nextjs-ubuntu24 candidate ID.')
  if (FRAMEWORK === 'vite' && !TEMPLATE.includes('vite')) throw new Error('Vite verification requires a lampcode-vite-ubuntu24 candidate ID.')

  console.log(`Starting ${FRAMEWORK} sandbox from "${TEMPLATE}"…`)
  const sandbox = await Sandbox.create(TEMPLATE, { timeoutMs: 10 * 60 * 1000 })
  console.log(`Sandbox ${sandbox.sandboxId} up.\n`)

  const run = async (cmd: string, cwd?: string, timeoutMs = 120_000) => {
    try {
      const r = await sandbox.commands.run(cmd, { ...(cwd ? { cwd } : {}), timeoutMs })
      return { out: `${r.stdout}${r.stderr}`, code: r.exitCode ?? 0 }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number; message?: string }
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? String(err)), code: e.exitCode ?? -1 }
    }
  }

  try {
    const who = await run('id -un; printf "HOME=%s\\n" "$HOME"')
    const whoLines = who.out.trim().split('\n')
    report('sandbox runs as the E2B user', who.code === 0 && whoLines[0] === 'user' && whoLines[1] === 'HOME=/home/user', who.out.trim())

    if (EXPECT_UBUNTU) {
      const os = await run('grep -q \'^VERSION_ID="24.04"$\' /etc/os-release && . /etc/os-release && echo "$PRETTY_NAME"')
      report('Ubuntu 24.04 is the final sandbox OS', os.code === 0 && os.out.includes('24.04'), os.out.trim())

      const toolchain = await run('node --version && npm --version && python3 --version && pip --version && git --version && rg --version | head -n 1 && jq --version && make --version | head -n 1 && gcc --version | head -n 1 && tsx --version && tsc --version')
      const good = toolchain.code === 0 && toolchain.out.includes('v22.23.5') &&
        toolchain.out.includes('git version') && toolchain.out.includes('ripgrep') &&
        toolchain.out.includes('jq-') && toolchain.out.includes('GNU Make') && toolchain.out.includes('gcc')
      report('Node/npm, Python/pip, Git and Linux build utilities exist', good, toolchain.out.trim())

      const py = await run('command -v python3 && python3 -c "import sys, fastapi, uvicorn, supabase; print(sys.executable); print(sys.prefix)" && command -v pip && pip --version')
      report('login-shell Python and pip resolve to the dedicated venv', py.code === 0 &&
        py.out.includes('/opt/lampcode-python/bin/python3') && py.out.includes('/opt/lampcode-python/bin/pip') &&
        py.out.includes('/opt/lampcode-python'), py.out.trim())

      const globalPackages = await run('python3 -m pip list --format=freeze')
      report('the global Python site is not used for app dependencies', globalPackages.code === 0 &&
        !globalPackages.out.includes('crewai==') && !globalPackages.out.includes('langgraph=='), globalPackages.out.trim().slice(0, 500))

      const apt = await run(
        // Ubuntu mirrors can briefly serve a Release index and Packages file
        // from different sync generations. Retry metadata refresh a few times
        // without disabling signature/hash verification or weakening apt.
        'updated=0; for attempt in 1 2 3; do if sudo -n /usr/local/bin/lampcode-apt update; then updated=1; break; fi; if [ "$attempt" -lt 3 ]; then sleep 15; fi; done; [ "$updated" -eq 1 ] || exit 1; sudo -n /usr/local/bin/lampcode-apt install tree && tree --version',
        PROJECT_DIR,
        240_000,
      )
      report(
        'project user can install an OS package through the approval-gated apt wrapper',
        apt.code === 0 && apt.out.toLowerCase().includes('tree'),
        apt.out.trim().slice(-1200),
      )

      const aptReject = await run(
        'if sudo -n /usr/local/bin/lampcode-apt install /tmp/unsafe-package.deb; then echo UNSAFE_PACKAGE_ACCEPTED; exit 1; else echo INVALID_PACKAGE_REJECTED; fi',
        PROJECT_DIR,
        10_000,
      )
      report(
        'apt wrapper rejects local package files',
        aptReject.code === 0 && aptReject.out.includes('INVALID_PACKAGE_REJECTED') && !aptReject.out.includes('UNSAFE_PACKAGE_ACCEPTED'),
        aptReject.out.trim(),
      )
    }

    const entry = await run(ENTRY_CHECK, PROJECT_DIR)
    report(`${FRAMEWORK} project scaffold is present`, entry.code === 0, entry.out.trim())

    const writeProbe = await run('touch node_modules/.lampcode-write-probe && rm node_modules/.lampcode-write-probe && echo WRITABLE', PROJECT_DIR)
    report('project node_modules is writable by sandbox user', writeProbe.code === 0 && writeProbe.out.includes('WRITABLE'), writeProbe.out.trim())

    const tools = await run(`ls -1 ${TOOLS_DIR}/browsers && ls -1 ${TOOLS_DIR}/check-render.mjs`)
    report('Chromium and shared render tooling are baked', tools.code === 0 && tools.out.includes('chromium') && tools.out.includes('check-render.mjs'), tools.out.trim())

    const launch = await run(`${TOOLS_ENV} node -e "import('playwright').then(async (p) => { const b = await p.chromium.launch(); await b.close(); console.log('CHROMIUM OK') }).catch((e) => { console.error(e); process.exit(1) })"`, TOOLS_DIR)
    report('Playwright Chromium launches as sandbox user', launch.code === 0 && launch.out.includes('CHROMIUM OK'), launch.out.trim())

    if (FRAMEWORK === 'nextjs') {
      const shadcnVersion = await run('npx shadcn --version', PROJECT_DIR, 60_000)
      report('pinned shadcn CLI is available in the Next.js project', shadcnVersion.code === 0 && shadcnVersion.out.includes('4.23.0'), shadcnVersion.out.trim())
      const shadcnAdd = await run('npx shadcn add accordion --yes', PROJECT_DIR, 180_000)
      const accordionFile = await run('test -s components/ui/accordion.tsx', PROJECT_DIR)
      report('shadcn CLI adds a real Tailwind v4/Radix component from components.json', shadcnAdd.code === 0 && accordionFile.code === 0, shadcnAdd.out.slice(-1200).trim())
    }

    // Exercise a real framework API handler, not just the frontend page.
    // Vite's backend is provided by Hono on :3001 and reached through its
    // configured /api proxy. Next.js owns its Route Handler on :3000.
    if (FRAMEWORK === 'vite') {
      const dir = await run('mkdir -p src/server', PROJECT_DIR)
      report('Hono backend fixture directory is writable', dir.code === 0, dir.out.trim())
      await sandbox.files.write('/home/user/app/src/server/app.ts',
        'import { Hono } from "hono"\n' +
        'export const app = new Hono()\n' +
        'app.get("/api/health", (c) => c.json({ ok: true, runtime: "hono" }))\n')
      await sandbox.files.write('/home/user/app/src/server/index.ts',
        'import { serve } from "@hono/node-server"\n' +
        'import { app } from "./app.js"\n' +
        'const port = Number(process.env.PORT ?? 3001)\n' +
        'serve({ fetch: app.fetch, port, hostname: "0.0.0.0" })\n')
    } else {
      const dir = await run('mkdir -p app/api/health', PROJECT_DIR)
      report('Next.js Route Handler fixture directory is writable', dir.code === 0, dir.out.trim())
      await sandbox.files.write('/home/user/app/app/api/health/route.ts',
        'export function GET() {\n' +
        '  return Response.json({ ok: true, runtime: "nextjs" })\n' +
        '}\n')
    }

    const fastApiDir = '/tmp/lampcode-fastapi-canary'
    const fastApiDirResult = await run('mkdir -p ' + fastApiDir)
    report('FastAPI canary directory is writable', fastApiDirResult.code === 0, fastApiDirResult.out.trim())
    await sandbox.files.write(fastApiDir + '/main.py',
      'from fastapi import FastAPI\n' +
      'app = FastAPI()\n' +
      '@app.get("/api/health")\n' +
      'def health():\n' +
      '    return {"ok": True, "runtime": "fastapi"}\n')

    const testRoot = FRAMEWORK === 'nextjs' ? 'lib' : 'src/lib'
    const componentRoot = FRAMEWORK === 'nextjs' ? 'components' : 'src/components'
    await sandbox.files.write(`${PROJECT_DIR}/${testRoot}/totals.ts`,
      'export const subtotal = (items: Array<{ price: number; qty: number }>) => items.reduce((s, i) => s + i.price * i.qty, 0);\n')
    await sandbox.files.write(`${PROJECT_DIR}/${testRoot}/totals.test.ts`,
      'import { describe, it, expect } from "vitest";\nimport { subtotal } from "@/lib/totals";\ndescribe("subtotal", () => { it("sums price times quantity", () => { expect(subtotal([{ price: 10, qty: 2 }, { price: 5, qty: 3 }])).toBe(35); }); });\n')
    await sandbox.files.write(`${PROJECT_DIR}/${componentRoot}/Badge.tsx`,
      'export function Badge({ label }: { label: string }) { return <span className="badge">{label}</span>; }\n')
    await sandbox.files.write(`${PROJECT_DIR}/${componentRoot}/Badge.test.tsx`,
      `import { describe, it, expect } from "vitest";\nimport { render, screen } from "@testing-library/react";\nimport { Badge } from "${FRAMEWORK === 'nextjs' ? '@/components/Badge' : './Badge'}";\ndescribe("Badge", () => { it("renders its label", () => { render(<Badge label="New" />); expect(screen.getByText("New")).toBeInTheDocument(); }); });\n`)

    const tests = await run('npx vitest run --reporter=dot', PROJECT_DIR, 180_000)
    report('Vitest executes logic and React component tests', tests.code === 0 && /2 passed|2\s+tests? passed/i.test(tests.out), tests.out.slice(-900).trim())

    const types = await run('npx tsc --noEmit --pretty false', PROJECT_DIR, 90_000)
    report('TypeScript typecheck passes for application and tests', types.code === 0, types.out.slice(0, 1000).trim())

    const productionBuild = await run('npm run build', PROJECT_DIR, 240_000)
    report(`${FRAMEWORK} production build passes`, productionBuild.code === 0, productionBuild.out.slice(-1800).trim())

    // Prove the Python venv can serve a real HTTP API request. This runs beside
    // the selected frontend framework so both candidates cover FastAPI too.
    let fastApiReady = false
    try {
      const started = await sandbox.commands.run(
        '/opt/lampcode-python/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 3002',
        { cwd: fastApiDir, background: true, timeoutMs: 0 },
      )
      void started
      const api = await run(
        "for i in $(seq 1 30); do body=$(curl -fsS http://127.0.0.1:3002/api/health 2>/dev/null || true); if [ \"$body\" = '{\"ok\":true,\"runtime\":\"fastapi\"}' ]; then echo FASTAPI API READY; exit 0; fi; sleep 1; done; echo FASTAPI API NOT READY; exit 1",
        fastApiDir,
        35_000,
      )
      fastApiReady = api.code === 0 && api.out.includes('FASTAPI API READY')
      report('FastAPI serves a real JSON API request from the dedicated Python venv', fastApiReady, api.out.trim())
    } catch (err) {
      report('FastAPI serves a real JSON API request from the dedicated Python venv', false, err instanceof Error ? err.message : String(err))
    }

    // The Vite candidate's Hono backend starts through the same tsx entry
    // point used by e2b-service and is reachable on :3001.
    let honoReady = false
    if (FRAMEWORK === 'vite') {
      try {
        const started = await sandbox.commands.run(
          "NODE_OPTIONS='--experimental-websocket' tsx src/server/index.ts",
          { cwd: PROJECT_DIR, background: true, timeoutMs: 0, envs: { PORT: '3001' } },
        )
        void started
        const api = await run(
          "for i in $(seq 1 30); do body=$(curl -fsS http://127.0.0.1:3001/api/health 2>/dev/null || true); if [ \"$body\" = '{\"ok\":true,\"runtime\":\"hono\"}' ]; then echo HONO API READY; exit 0; fi; sleep 1; done; echo HONO API NOT READY; exit 1",
          PROJECT_DIR,
          35_000,
        )
        honoReady = api.code === 0 && api.out.includes('HONO API READY')
        report('Hono backend starts with LampCode tsx entrypoint and serves JSON on :3001', honoReady, api.out.trim())
      } catch (err) {
        report('Hono backend starts with LampCode tsx entrypoint and serves JSON on :3001', false, err instanceof Error ? err.message : String(err))
      }
    }

    // Start the exact framework server LampCode's preview manager uses, then
    // inspect the live page in Chromium (not just the image's installed files).
    const devServerEnvs = FRAMEWORK === 'nextjs'
      ? { LAMPCODE_PREVIEW_HOST: sandbox.getHost(PORT) }
      : undefined
    const start = await sandbox.commands.run('npm run dev', {
      cwd: PROJECT_DIR,
      background: true,
      timeoutMs: 0,
      ...(devServerEnvs ? { envs: devServerEnvs } : {}),
    })
    void start
    const ready = await run(`for i in $(seq 1 90); do if curl -fsS http://127.0.0.1:${PORT}/ >/dev/null; then echo SERVER READY; exit 0; fi; sleep 1; done; echo SERVER NOT READY; exit 1`, PROJECT_DIR, 100_000)
    report(`${FRAMEWORK} dev server becomes ready on :${PORT}`, ready.code === 0 && ready.out.includes('SERVER READY'), ready.out.trim())

    if (ready.code === 0) {
      // Test the same public HTTPS ingress that the user's preview iframe
      // uses. The Vite template intentionally advertises secure WSS on 443;
      // testing localhost would bypass that proxy and produce a false failure.
      const browserUrl = `https://${sandbox.getHost(PORT)}`
      const browserCheck = await run(`${TOOLS_ENV} node ${TOOLS_DIR}/check-render.mjs ${JSON.stringify(browserUrl)}`, PROJECT_DIR, 60_000)
      let parsed: { ok?: boolean; blank?: boolean; errors?: string[] } | null = null
      try { parsed = JSON.parse(browserCheck.out.trim().split(/\r?\n/).at(-1) ?? '') } catch { parsed = null }
      report('independent browser render check passes through the public E2B HTTPS/WSS host', parsed?.ok === true && parsed.blank === false && (parsed.errors?.length ?? 0) === 0, browserCheck.out.slice(-1000).trim())

      if (FRAMEWORK === 'vite' && honoReady) {
        const proxy = await run('curl -fsS http://127.0.0.1:5173/api/health', PROJECT_DIR, 15_000)
        report(
          'Vite /api proxy forwards a real request to the Hono backend',
          proxy.code === 0 && proxy.out.trim() === '{"ok":true,"runtime":"hono"}',
          proxy.out.trim(),
        )
      }

      if (FRAMEWORK === 'nextjs') {
        const route = await run(
          "for i in $(seq 1 30); do body=$(curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null || true); if [ \"$body\" = '{\"ok\":true,\"runtime\":\"nextjs\"}' ]; then echo NEXT API READY; exit 0; fi; sleep 1; done; echo NEXT API NOT READY; exit 1",
          PROJECT_DIR,
          35_000,
        )
        report(
          'Next.js App Router Route Handler serves a real JSON API request',
          route.code === 0 && route.out.includes('NEXT API READY'),
          route.out.trim(),
        )
      }
    }
  } finally {
    await sandbox.kill().catch(() => {})
    console.log('\nSandbox killed.')
  }

  console.log(failures === 0 ? '\nEverything checked passed.' : `\n${failures} check(s) FAILED — candidate is not ready.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Template verification crashed:', err)
  process.exit(1)
})
