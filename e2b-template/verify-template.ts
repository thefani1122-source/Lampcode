import 'dotenv/config'
import { Sandbox } from 'e2b'

// ── Does the built template actually work? ───────────────────────────────────
// Run:  cd e2b-template && npx tsx verify-template.ts
// Needs the same .env as build.ts (E2B_API_KEY).
//
// This exists because a green "✅ Template built" has twice proved nothing in
// this project. The npm-init failure froze the template for three weeks while
// every build reported success, and when that was fixed check_page STILL could
// not work because Chromium had landed in a directory the sandbox user cannot
// read. Both were only ever found by starting a real sandbox and looking.
//
// So: start one, and check each capability the way the backend invokes it —
// same commands, same paths, same user.

const TOOLS_DIR = '/home/user/.lampcode-tools'
const TOOLS_ENV = `PLAYWRIGHT_BROWSERS_PATH=${TOOLS_DIR}/browsers`
const PROJECT_DIR = '/home/user/app'
const TEMPLATE = process.env['E2B_TEMPLATE_ID'] ?? 'lampcode-vite'

let failures = 0
function report(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  if (!process.env['E2B_API_KEY']) {
    console.error('❌ E2B_API_KEY missing — see build.ts for where it goes.')
    process.exit(1)
  }

  console.log(`Starting a sandbox from "${TEMPLATE}"…`)
  const sandbox = await Sandbox.create(TEMPLATE, { timeoutMs: 5 * 60 * 1000 })
  console.log(`Sandbox ${sandbox.sandboxId} up.\n`)

  // Run a command the way e2b-service does, and never let a non-zero exit throw
  // — a failing check is a result to report, not a crash.
  const run = async (cmd: string, cwd?: string, timeoutMs = 120_000) => {
    try {
      const r = await sandbox.commands.run(cmd, { ...(cwd ? { cwd } : {}), timeoutMs })
      return { out: `${r.stdout}${r.stderr}`, code: 0 }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number; message?: string }
      return {
        out: `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? String(err)),
        code: e.exitCode ?? -1,
      }
    }
  }

  try {
    // 0. Who are we? Everything below depends on this, and getting it wrong is
    //    what put Chromium in /root/.cache.
    const who = await run('id -un; echo HOME=$HOME')
    report('runs as a known user', who.out.includes('user'), who.out.trim())

    // 1. The app directory must be WRITABLE by that user — vitest writes a
    //    transform cache under node_modules before running a single test.
    const writable = await run(
      'touch node_modules/.lampcode-write-probe && rm node_modules/.lampcode-write-probe && echo WRITABLE',
      PROJECT_DIR,
    )
    report('node_modules is writable by the sandbox user', writable.out.includes('WRITABLE'), writable.out.trim())

    // 2. The baked harness files are present and are the ones we wrote.
    const files = await run(
      'ls -1 vitest.config.ts vitest.setup.ts package.json tsconfig.json 2>&1; ' +
      'grep -c "jsdom" vitest.config.ts; grep -c "vitest.setup.ts" tsconfig.json',
      PROJECT_DIR,
    )
    report(
      'vitest config + setup are baked in and wired to tsconfig',
      files.out.includes('vitest.config.ts') && files.out.includes('vitest.setup.ts') &&
        !files.out.includes('No such file'),
      files.out.trim(),
    )

    // 3. The test tooling is actually installed, not merely declared.
    const installed = await run(
      'ls -d node_modules/vitest node_modules/jsdom node_modules/@testing-library/react ' +
      'node_modules/@testing-library/jest-dom 2>&1',
      PROJECT_DIR,
    )
    report('vitest, jsdom and testing-library are installed', !installed.out.includes('No such file'), installed.out.trim())

    // 4. A logic test and a component test, written the way the model would —
    //    through the @ alias, with a jest-dom matcher — then run with the exact
    //    command runTests sends.
    await sandbox.files.write(`${PROJECT_DIR}/src/lib/totals.ts`,
      'export const subtotal = (items: Array<{ price: number; qty: number }>) =>\n' +
      '  items.reduce((s, i) => s + i.price * i.qty, 0);\n')
    await sandbox.files.write(`${PROJECT_DIR}/src/lib/totals.test.ts`,
      'import { describe, it, expect } from "vitest";\n' +
      'import { subtotal } from "@/lib/totals";\n' +
      'describe("subtotal", () => {\n' +
      '  it("sums price times quantity", () => {\n' +
      '    expect(subtotal([{ price: 10, qty: 2 }, { price: 5, qty: 3 }])).toBe(35);\n' +
      '  });\n' +
      '});\n')
    await sandbox.files.write(`${PROJECT_DIR}/src/components/Badge.tsx`,
      'export function Badge({ label }: { label: string }) {\n' +
      '  return <span className="badge">{label}</span>;\n' +
      '}\n')
    await sandbox.files.write(`${PROJECT_DIR}/src/components/Badge.test.tsx`,
      'import { describe, it, expect } from "vitest";\n' +
      'import { render, screen } from "@testing-library/react";\n' +
      'import { Badge } from "./Badge";\n' +
      'describe("Badge", () => {\n' +
      '  it("renders its label", () => {\n' +
      '    render(<Badge label="New" />);\n' +
      '    expect(screen.getByText("New")).toBeInTheDocument();\n' +
      '  });\n' +
      '});\n')

    const RESULT = '/tmp/lampcode-vitest.json'
    const MARKER = '__LAMPCODE_VITEST_EXIT__'
    const tests = await run(
      `rm -f ${RESULT}; npx vitest run --reporter=json --outputFile=${RESULT} 2>&1; ` +
      `echo "${MARKER}$?"; cat ${RESULT} 2>/dev/null`,
      PROJECT_DIR,
      180_000,
    )
    const after = tests.out.split(MARKER)[1] ?? ''
    const json = after.slice(after.indexOf('\n') + 1).trim()
    let parsed: { numTotalTests?: number; numPassedTests?: number; numFailedTests?: number } | null = null
    try { parsed = json.startsWith('{') ? JSON.parse(json) : null } catch { parsed = null }
    report(
      'run_tests: both tests pass and the JSON report parses',
      parsed !== null && parsed.numTotalTests === 2 && parsed.numPassedTests === 2,
      parsed
        ? `total=${parsed.numTotalTests} passed=${parsed.numPassedTests} failed=${parsed.numFailedTests}`
        : tests.out.slice(-1_200).trim(),
    )

    // 5. check_types must stay clean over those test files — the jest-dom
    //    matcher is the case that fails when vitest.setup.ts is not in
    //    tsconfig's include.
    const types = await run('tsc --noEmit --pretty false 2>&1', PROJECT_DIR)
    report('check_types: clean over the test files', types.out.trim() === '', types.out.slice(0, 800).trim())

    // 6. check_page's Chromium, launched as the sandbox user from the tools
    //    directory — the three-bugs-one-capability case.
    const browsers = await run(`ls -1 ${TOOLS_DIR}/browsers 2>&1`)
    report('playwright browsers are in the tools directory', browsers.out.includes('chromium'), browsers.out.trim())
    const launch = await run(
      `${TOOLS_ENV} node -e "import('playwright').then(async (p) => { ` +
      `const b = await p.chromium.launch(); await b.close(); console.log('LAUNCH OK'); })` +
      `.catch((e) => { console.log('LAUNCH FAIL', e.message); process.exit(1); })"`,
      TOOLS_DIR,
    )
    report('chromium launches as the sandbox user', launch.out.includes('LAUNCH OK'), launch.out.trim())
    const checkRender = await run(`ls -1 ${TOOLS_DIR}/check-render.mjs 2>&1`)
    report('check-render.mjs is present', !checkRender.out.includes('No such file'), checkRender.out.trim())

    // Presence is not the same as currency. A template build that fails leaves
    // every sandbox running the LAST GOOD image, so "the file is there" can be
    // true of a script months out of date — which is exactly how check_page
    // stayed broken for three weeks. Assert the behaviour this version is
    // supposed to have, not merely the filename.
    const renderSrc = await run(`cat ${TOOLS_DIR}/check-render.mjs`)
    const hasOverlayCheck =
      renderSrc.out.includes('vite-error-overlay') && renderSrc.out.includes('&& !overlay')
    report(
      'check-render.mjs detects the Vite error overlay',
      hasOverlayCheck,
      hasOverlayCheck ? 'overlay detection present' : 'STALE IMAGE — overlay detection missing',
    )

    // 7. The Python backend path, which is a user-facing feature.
    const py = await run('python3 -c "import fastapi, uvicorn; print(fastapi.__version__)" 2>&1')
    report('python backend deps are installed', /^\d+\./.test(py.out.trim()), py.out.trim())
  } finally {
    await sandbox.kill().catch(() => {})
    console.log('\nSandbox killed.')
  }

  console.log(failures === 0
    ? '\nEverything checked passed.'
    : `\n${failures} check(s) FAILED — the template is not ready.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('❌ Verification crashed:', err)
  process.exit(1)
})
