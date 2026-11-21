import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  COMMON_QA_COMMANDS,
  CHECK_RENDER_MJS,
  COMMON_SCAFFOLD_COMMANDS,
  NODE_INSTALL_COMMAND,
  NODE_SHA256_BY_ARCH,
  NODE_VERSION,
  PYTHON_BASE_PACKAGES,
  PYTHON_SETUP_COMMAND,
  UBUNTU_APT_PACKAGES,
  UBUNTU_BASE_IMAGE,
  UBUNTU_TEMPLATE_ENVS,
  dockerfile,
  VITE_PKG_JSON,
  ubuntuTemplate,
  createUbuntuBaseTemplate,
  LAMPCODE_APT_WRAPPER_SCRIPT,
  LAMPCODE_APT_SETUP_COMMAND,
  LAMPCODE_LOGIN_ENV_SETUP_COMMAND,
  LAMPCODE_LOGIN_ENV_SCRIPT,
} from '../e2b-template/template.js'
import { NEXTJS_PKG_JSON, NEXTJS_VERSION, NEXTJS_REACT_VERSION, NEXTJS_SCAFFOLD_COMMANDS, NEXT_QUERY_CLIENT_TS, NEXT_PROVIDERS_TS, NEXT_VITEST_CONFIG, NEXT_CONFIG, NEXTJS_COMPONENTS_JSON, NEXTJS_STYLES_CSS, ubuntuNextTemplate } from '../e2b-template/template-nextjs-ubuntu.js'
import { nextjsVercelScaffold } from '../src/deploy/nextjs-scaffold.js'

// Existing production Node 20 image stays unchanged and remains Vite.
assert.match(dockerfile, /^FROM node:20-slim/m)
assert.ok(dockerfile.startsWith('FROM node:20-slim\n'))
assert.ok(dockerfile.includes('\nRUN '))
assert.ok(!dockerfile.includes('\\n'))
assert.ok(dockerfile.includes('pip3 install --no-cache-dir --break-system-packages'))
assert.ok(dockerfile.includes('ENV PLAYWRIGHT_BROWSERS_PATH=/home/user/.lampcode-tools/browsers'))

// Ubuntu base is shared by both framework-specific candidate images.
assert.ok(ubuntuTemplate)
assert.ok(ubuntuNextTemplate)
assert.ok(createUbuntuBaseTemplate())
assert.equal(UBUNTU_BASE_IMAGE, '24.04')
for (const name of ['git', 'build-essential', 'python3-venv', 'libpq-dev', 'ripgrep', 'jq', 'sqlite3', 'sudo', 'coreutils', 'less', 'xz-utils']) {
  assert.ok(UBUNTU_APT_PACKAGES.includes(name as never), `missing Ubuntu package ${name}`)
}
assert.equal(UBUNTU_TEMPLATE_ENVS.PLAYWRIGHT_BROWSERS_PATH, '/home/user/.lampcode-tools/browsers')
assert.ok(!('PATH' in UBUNTU_TEMPLATE_ENVS), 'do not override the system PATH used by E2B envd')
assert.deepEqual(PYTHON_BASE_PACKAGES, ['fastapi', 'uvicorn[standard]', 'supabase', 'python-dotenv'])
assert.ok(PYTHON_SETUP_COMMAND.includes('python3 -m venv /opt/lampcode-python'))
assert.ok(PYTHON_SETUP_COMMAND.includes('/opt/lampcode-python/bin/pip install'))
assert.ok(!PYTHON_SETUP_COMMAND.includes('--break-system-packages'))
assert.ok(!PYTHON_SETUP_COMMAND.includes('crewai'))
assert.ok(!PYTHON_SETUP_COMMAND.includes('langgraph'))
assert.ok(UBUNTU_APT_PACKAGES.includes('sudo' as never), 'sandbox package manager is installed')
assert.ok(LAMPCODE_APT_WRAPPER_SCRIPT.includes('/usr/bin/apt-get update'))
assert.ok(LAMPCODE_APT_WRAPPER_SCRIPT.includes('/usr/bin/apt-get install -y --no-install-recommends'))
assert.ok(LAMPCODE_APT_WRAPPER_SCRIPT.includes('Rejected package argument'), 'apt wrapper validates package-only arguments')
assert.ok(!LAMPCODE_APT_WRAPPER_SCRIPT.includes('apt-get remove'), 'apt wrapper cannot remove system packages')
assert.ok(LAMPCODE_APT_SETUP_COMMAND.includes('visudo -cf /etc/sudoers.d/90-lampcode-apt'))
assert.ok(LAMPCODE_APT_SETUP_COMMAND.includes('chmod 0440 /etc/sudoers.d/90-lampcode-apt'))
assert.ok(LAMPCODE_LOGIN_ENV_SETUP_COMMAND.includes('/home/user/.profile'))
assert.ok(LAMPCODE_LOGIN_ENV_SETUP_COMMAND.includes('/home/user/.bashrc'))
assert.ok(LAMPCODE_LOGIN_ENV_SETUP_COMMAND.includes('chown user:user'), 'venv PATH is scoped to the project user')
assert.ok(LAMPCODE_LOGIN_ENV_SCRIPT.includes('/opt/lampcode-python/bin:$PATH'))
assert.ok(LAMPCODE_APT_SETUP_COMMAND.includes('visudo -cf /etc/sudoers.d/90-lampcode-apt'), 'the restricted apt helper still validates sudoers')
assert.ok(UBUNTU_APT_PACKAGES.includes('coreutils' as never), 'Ubuntu core shell utilities remain installed')
const ubuntuVerifier = readFileSync(new URL('../e2b-template/verify-template.ts', import.meta.url), 'utf8')
const verifierFixtures = ubuntuVerifier.slice(ubuntuVerifier.indexOf('const testRoot ='), ubuntuVerifier.indexOf('const tests ='))
assert.ok(!verifierFixtures.includes(String.raw`\\n`), 'generated verifier fixtures contain real newline escapes, not literal backslash-n text')
assert.ok(ubuntuVerifier.includes('command -v python3') && ubuntuVerifier.includes('/opt/lampcode-python/bin/pip'), 'verifier proves login-shell Python and pip resolve to the venv')
assert.ok(ubuntuVerifier.includes('sandbox.getHost(PORT)'), 'browser QA runs through the public E2B preview host so HMR uses HTTPS/WSS ingress')
assert.ok(ubuntuVerifier.includes('FastAPI serves a real JSON API request from the dedicated Python venv'), 'Ubuntu verifier proves the Python venv can serve an HTTP API')
assert.ok(ubuntuVerifier.includes('Hono backend starts with LampCode tsx entrypoint'), 'Vite candidate exercises the Hono backend entrypoint')
assert.ok(ubuntuVerifier.includes('Vite /api proxy forwards a real request to the Hono backend'), 'Vite candidate proves its /api proxy reaches Hono')
assert.ok(ubuntuVerifier.includes('Next.js App Router Route Handler serves a real JSON API request'), 'Next.js candidate exercises an actual App Router API handler')
assert.ok(ubuntuVerifier.includes('/opt/lampcode-python/bin/python3 -m uvicorn main:app'), 'FastAPI canary uses the image-provided Python venv and uvicorn')
assert.ok(ubuntuVerifier.includes('for attempt in 1 2 3'), 'apt verifier retries transient Ubuntu mirror sync failures')
assert.ok(ubuntuVerifier.includes('sleep 15'), 'apt retries are spaced to allow mirror metadata to converge')
assert.ok(!ubuntuVerifier.includes('Acquire::AllowInsecureRepositories'), 'apt mirror retries do not weaken repository signature or hash verification')


assert.equal(NODE_VERSION, '22.23.5')
assert.match(NODE_INSTALL_COMMAND, /node-v22\.23\.5-linux-\$\{NODE_ARCH\}/)
assert.ok(NODE_INSTALL_COMMAND.includes('sha256sum -c -'))
assert.ok(NODE_INSTALL_COMMAND.includes(NODE_SHA256_BY_ARCH.amd64))
assert.ok(NODE_INSTALL_COMMAND.includes(NODE_SHA256_BY_ARCH.arm64))
assert.ok(NODE_INSTALL_COMMAND.includes('test "$(node --version)" = "v22.23.5"'))

// Large animation/3D packages are no longer baked into every Vite user project.
const vitePkg = JSON.parse(VITE_PKG_JSON) as { dependencies: Record<string, string> }
for (const optional of ['@react-three/fiber', '@react-three/drei', '@splinetool/react-spline', 'gsap', 'motion', 'three', 'lenis']) {
  assert.ok(!(optional in vitePkg.dependencies), `optional package ${optional} must not be in the always-installed scaffold`)
}

// QA tools are shared; framework-specific scaffolds are separate.
for (const capability of ['playwright install --with-deps chromium', 'check-render.mjs', 'chown -R user:user /home/user/.lampcode-tools']) {
  assert.ok(COMMON_QA_COMMANDS.some((command) => command.includes(capability)))
  assert.ok(COMMON_SCAFFOLD_COMMANDS.some((command) => command.includes(capability)))
}
for (const capability of ['vite.config.ts', 'src/index.tsx', 'index.html']) {
  assert.ok(COMMON_SCAFFOLD_COMMANDS.some((command) => command.includes(capability)))
}
for (const capability of ['next.config.ts', 'app/layout.tsx', 'app/page.tsx', 'postcss.config.mjs', 'vitest.config.ts', 'components/ui/button.tsx']) {
  assert.ok(NEXTJS_SCAFFOLD_COMMANDS.some((command) => command.includes(capability)))
}
assert.equal(NEXTJS_VERSION, '16.4.6')
assert.equal(NEXTJS_REACT_VERSION, '19.2.0')
const nextPkg = JSON.parse(NEXTJS_PKG_JSON) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
assert.equal(nextPkg.dependencies.next, NEXTJS_VERSION)
assert.equal(nextPkg.dependencies.react, NEXTJS_REACT_VERSION)
assert.equal(nextPkg.devDependencies.shadcn, '4.23.0', 'pin the shadcn CLI used by generated projects')
assert.equal(nextPkg.devDependencies['tw-animate-css'], '1.4.0', 'pin Tailwind v4 animation utilities')
assert.ok(NEXTJS_COMPONENTS_JSON.includes('"$schema": "https://ui.shadcn.com/schema.json"'))
assert.ok(NEXTJS_COMPONENTS_JSON.includes('"css": "app/globals.css"'))
assert.ok(NEXTJS_COMPONENTS_JSON.includes('"ui": "@/components/ui"'))
assert.ok(NEXTJS_STYLES_CSS.includes('@import "tailwindcss";\\n@import "tw-animate-css";'))
assert.ok(NEXTJS_SCAFFOLD_COMMANDS.some((command) => command.includes('/home/user/app/components.json')))
assert.ok(NEXTJS_SCAFFOLD_COMMANDS.some((command) => command.includes('/home/user/app/app/globals.css')))
assert.equal(nextPkg.devDependencies.vitest, '^5.0.0', 'Vitest 5 uses the same Vite major/minor line')
assert.equal(nextPkg.devDependencies.vite, '^6.4.0', 'Vitest 5 requires Vite 6.4+ and Node 22.12+')
assert.ok(CHECK_RENDER_MJS.includes('[data-nextjs-dialog-overlay]'))
assert.ok(!CHECK_RENDER_MJS.includes('[data-nextjs-toast]'), 'benign Next.js dev indicator toast is not treated as an error')
assert.ok(CHECK_RENDER_MJS.includes('.replace(/\\s+/g, " ")'), 'browser overlay text normalization uses a whitespace regex, not a literal slash-s expression')
assert.ok(!CHECK_RENDER_MJS.includes('readOverlay(document.querySelector("nextjs-portal"))'), 'Next portal styles are not mistaken for an error overlay')
assert.ok(nextPkg.devDependencies['@tailwindcss/postcss'], 'Tailwind PostCSS is a build-time plugin')
assert.ok(nextPkg.dependencies['@radix-ui/react-dialog'])
assert.ok(!nextPkg.dependencies.three, 'Three.js should be installed only when the generated app imports it')

// Next.js SSR must not reuse one module-level QueryClient across user requests.
assert.match(NEXT_QUERY_CLIENT_TS, /export function createQueryClient\(\)/)
assert.match(NEXT_PROVIDERS_TS, /useState\(\(\) => createQueryClient\(\)\)/)
assert.ok(!NEXT_PROVIDERS_TS.includes("import { queryClient }"))
assert.ok(NEXT_VITEST_CONFIG.includes("import.meta.url"), 'Vitest alias resolves correctly in the ESM project')
assert.ok(!NEXT_VITEST_CONFIG.includes('__dirname'), 'Vitest config does not rely on CommonJS globals')
assert.match(NEXT_CONFIG, /allowedDevOrigins: previewHost \? \[previewHost\] : \[\]/)
assert.ok(NEXT_CONFIG.includes('process.env.LAMPCODE_PREVIEW_HOST'), 'Next.js only allows the exact runtime preview hostname')


const previewService = readFileSync(new URL('../src/preview/e2b-service.ts', import.meta.url), 'utf8')
const bakedStart = previewService.indexOf('const BAKED_FILES')
const bakedEnd = previewService.indexOf(']);', bakedStart)
const bakedFiles = previewService.slice(bakedStart, bakedEnd)
for (const path of ['postcss.config.mjs', 'components.json', 'app/providers.tsx', 'components/ui/button.tsx']) {
  assert.ok(bakedFiles.includes(path), `Next.js template-owned file ${path} is protected from generated overwrites`)
}

const deployed = nextjsVercelScaffold({
  'app/page.tsx': 'export default function Page() { return <main /> }',
  'app/layout.tsx': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }',
})
const deployedPackage = JSON.parse(deployed['package.json'] ?? '{}') as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
assert.equal(deployedPackage.devDependencies.shadcn, '4.23.0', 'Vercel scaffold preserves the pinned shadcn CLI')
assert.equal(deployedPackage.dependencies['tw-animate-css'], '1.4.0', 'Vercel scaffold includes Tailwind animation utilities')
const deployedComponents = JSON.parse(deployed['components.json'] ?? '{}') as { tailwind?: { css?: string } }
assert.equal(deployedComponents.tailwind?.css, 'app/globals.css', 'Vercel shadcn CSS path matches the App Router location')
assert.ok(deployed['app/globals.css']?.includes('@import "tw-animate-css";'))
assert.ok(deployed['postcss.config.mjs']?.includes('@tailwindcss/postcss'))

const deployedSrcApp = nextjsVercelScaffold({
  'src/app/page.tsx': 'export default function Page() { return <main /> }',
})
const deployedSrcComponents = JSON.parse(deployedSrcApp['components.json'] ?? '{}') as { tailwind?: { css?: string } }
assert.equal(deployedSrcComponents.tailwind?.css, 'src/app/globals.css', 'src/app projects get a matching shadcn CSS path')

const prewarmStart = previewService.indexOf('export function prewarmSandbox(')
const prewarmEnd = previewService.indexOf('/** Awaits an in-flight prewarm', prewarmStart)
assert.ok(prewarmStart >= 0 && prewarmEnd > prewarmStart, 'framework-aware prewarm function is present')
const prewarmSource = previewService.slice(prewarmStart, prewarmEnd)
assert.ok(prewarmSource.includes('liveFramework === framework'), 'prewarm reuses only a live sandbox for the requested framework')
assert.ok(prewarmSource.includes('selectTemplate(framework)'), 'prewarm validates the target template before replacing a working runtime')
assert.ok(!prewarmSource.includes('prewarm skipped: target runtime is not configured'), 'a missing target template cannot silently leave tools on a stale runtime')
assert.ok(prewarmSource.includes('warmingFrameworks.get(projectId) === framework'), 'prewarm recognises an in-flight warm for the same framework')
assert.ok(prewarmSource.includes('Replacing live') && prewarmSource.includes('Replacing warmed'), 'prewarm replaces live and in-flight mismatched frameworks')
assert.ok(prewarmSource.includes('warmingSandboxes.get(projectId) === promise'), 'older warm cleanup cannot delete a newer queued framework switch')
assert.ok(previewService.includes('warmingFrameworks.set(projectId, framework)'), 'normal preview acquisition records its in-flight framework')

const e2bBuilderPackage = JSON.parse(readFileSync(new URL('../e2b-template/package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }
assert.equal(e2bBuilderPackage.devDependencies.e2b, '2.64.0', 'E2B SDK pin includes the current glob/undici security fixes')

console.log('E2B Ubuntu Vite + Next.js template contract tests passed.')
