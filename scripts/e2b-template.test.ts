import assert from 'node:assert/strict'
import { dockerfile, ubuntuDockerfile } from '../e2b-template/template.js'

// Production remains on the known-good image until live E2B and staged canaries pass.
assert.match(dockerfile, /^FROM node:20-slim/m)
assert.ok(dockerfile.includes('pip3 install --no-cache-dir --break-system-packages'))
assert.match(ubuntuDockerfile, /^FROM node:22\.23\.5-bookworm-slim AS lampcode-node/m)
assert.match(ubuntuDockerfile, /^FROM ubuntu:24\.04/m)
assert.match(ubuntuDockerfile, /^COPY --from=lampcode-node \/usr\/local\/ \/usr\/local\//m)

assert.ok(ubuntuDockerfile.includes('python3 -m venv /opt/lampcode-python'))
assert.ok(ubuntuDockerfile.includes('/opt/lampcode-python/bin/pip install'))
assert.ok(ubuntuDockerfile.includes('ENV PATH="/opt/lampcode-python/bin:${PATH}"'))
assert.ok(!ubuntuDockerfile.includes('pip3 install'), 'Ubuntu must not install Python packages globally')
assert.ok(!ubuntuDockerfile.includes('--break-system-packages'))
assert.ok(!ubuntuDockerfile.includes('useradd'), 'E2B controls runtime-user creation')
assert.ok(ubuntuDockerfile.includes('RUN npm install -g vite tsx typescript'))

for (const required of [
  'ca-certificates', 'curl', 'git', 'python3-full', 'python3-venv',
  'build-essential', 'pkg-config', 'libpq-dev', 'unzip', 'zip',
  'jq', 'ripgrep', 'procps', 'sqlite3',
  'vitest.config.ts', 'vitest.setup.ts', 'tsconfig.json',
  'playwright install --with-deps chromium', 'check-render.mjs',
  'PLAYWRIGHT_BROWSERS_PATH=/home/user/.lampcode-tools/browsers',
  'vite-error-overlay', 'npm install --legacy-peer-deps',
]) {
  assert.ok(ubuntuDockerfile.includes(required), `Ubuntu candidate lost required capability: ${required}`)
}

console.log('E2B Ubuntu template contract tests passed.')
