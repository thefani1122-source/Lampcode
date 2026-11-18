import assert from 'node:assert/strict'
import { dockerfile, ubuntuDockerfile } from '../e2b-template/template.js'

assert.match(dockerfile, /^FROM node:20-slim/m, 'the current production image remains unchanged')
assert.match(ubuntuDockerfile, /^FROM node:22\.23\.5-bookworm-slim AS lampcode-node/m)
assert.match(ubuntuDockerfile, /^FROM ubuntu:24\.04/m)
assert.match(ubuntuDockerfile, /^COPY --from=lampcode-node \/usr\/local\/ \/usr\/local\//m)
assert.ok(ubuntuDockerfile.includes('python3 -m venv /opt/lampcode-python'))
assert.ok(ubuntuDockerfile.includes('ENV PATH="/opt/lampcode-python/bin:${PATH}"'))
assert.ok(!ubuntuDockerfile.includes('--break-system-packages'), 'Ubuntu system Python must remain externally managed')
assert.ok(!ubuntuDockerfile.includes('pip3 install'), 'Ubuntu candidate must not install Python packages globally')
assert.ok(ubuntuDockerfile.includes('RUN npm install -g vite tsx typescript'))
assert.ok(dockerfile.includes('pip3 install --no-cache-dir --break-system-packages'), 'legacy production Python package setup stays unchanged')

for (const required of [
  'vitest.config.ts',
  'vitest.setup.ts',
  'tsconfig.json',
  'playwright install --with-deps chromium',
  'check-render.mjs',
  'PLAYWRIGHT_BROWSERS_PATH=/home/user/.lampcode-tools/browsers',
  'vite-error-overlay',
  'npm install --legacy-peer-deps',
]) {
  assert.ok(ubuntuDockerfile.includes(required), `Ubuntu candidate lost shared QA/scaffold capability: ${required}`)
}

console.log('E2B Ubuntu template contract tests passed.')
