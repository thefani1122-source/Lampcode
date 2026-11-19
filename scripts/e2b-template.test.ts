import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  COMMON_QA_COMMANDS,
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
import { NEXTJS_PKG_JSON, NEXTJS_VERSION, NEXTJS_REACT_VERSION, NEXTJS_SCAFFOLD_COMMANDS, NEXT_QUERY_CLIENT_TS, NEXT_PROVIDERS_TS, NEXT_VITEST_CONFIG, NEXT_CONFIG, ubuntuNextTemplate } from '../e2b-template/template-nextjs-ubuntu.js'

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

const e2bBuilderPackage = JSON.parse(readFileSync(new URL('../e2b-template/package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }
assert.equal(e2bBuilderPackage.devDependencies.e2b, '2.64.0', 'E2B SDK pin includes the current glob/undici security fixes')

console.log('E2B Ubuntu Vite + Next.js template contract tests passed.')
