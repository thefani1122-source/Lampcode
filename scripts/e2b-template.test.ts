import assert from 'node:assert/strict'
import {
  COMMON_SCAFFOLD_COMMANDS,
  NODE_INSTALL_COMMAND,
  NODE_SHA256_BY_ARCH,
  NODE_VERSION,
  PYTHON_SETUP_COMMAND,
  UBUNTU_APT_PACKAGES,
  UBUNTU_BASE_IMAGE,
  dockerfile,
  ubuntuTemplate,
} from '../e2b-template/template.js'

// Production remains on the known-good Debian image until live E2B and staged canaries pass.
assert.match(dockerfile, /^FROM node:20-slim/m)
assert.ok(dockerfile.startsWith('FROM node:20-slim\\n'))
assert.ok(dockerfile.includes('\\nRUN '), 'legacy Dockerfile instructions must be newline-separated')
assert.ok(!dockerfile.includes('\\\\n'), 'legacy Dockerfile must not contain literal backslash-n sequences')
assert.ok(dockerfile.includes('pip3 install --no-cache-dir --break-system-packages'))

// Constructing the builder in this import also verifies the pinned E2B SDK
// exposes the Ubuntu-native builder methods used by the candidate.
assert.ok(ubuntuTemplate)
assert.equal(UBUNTU_BASE_IMAGE, '24.04')
assert.ok(UBUNTU_APT_PACKAGES.includes('git'))
assert.ok(UBUNTU_APT_PACKAGES.includes('build-essential'))
assert.ok(UBUNTU_APT_PACKAGES.includes('xz-utils'))

assert.equal(NODE_VERSION, '22.23.5')
assert.match(NODE_INSTALL_COMMAND, /fromUbuntuImage|node-v22\\.23\\.5-linux-/)
assert.ok(NODE_INSTALL_COMMAND.includes('sha256sum -c -'))
assert.ok(NODE_INSTALL_COMMAND.includes('${NODE_ARCH}'), 'architecture must expand inside the sandbox shell, not TypeScript')
assert.ok(NODE_INSTALL_COMMAND.includes(NODE_SHA256_BY_ARCH.amd64))
assert.ok(NODE_INSTALL_COMMAND.includes(NODE_SHA256_BY_ARCH.arm64))
assert.ok(NODE_INSTALL_COMMAND.includes('test "$(node --version)" = "v22.23.5"'))

assert.ok(PYTHON_SETUP_COMMAND.includes('python3 -m venv /opt/lampcode-python'))
assert.ok(PYTHON_SETUP_COMMAND.includes('/opt/lampcode-python/bin/pip install'))
assert.ok(!PYTHON_SETUP_COMMAND.includes('--break-system-packages'))

for (const required of [
  'vite.config.ts', 'vitest.config.ts', 'vitest.setup.ts', 'tsconfig.json',
  'npm install --legacy-peer-deps',
  'playwright install --with-deps chromium',
  'PLAYWRIGHT_BROWSERS_PATH',
  'check-render.mjs',
  'chown -R user:user /home/user/app',
  'chown -R user:user /home/user/.lampcode-tools',
]) {
  assert.ok(COMMON_SCAFFOLD_COMMANDS.some((command) => command.includes(required)), `shared scaffold lost: ${required}`)
}

console.log('E2B Ubuntu template contract tests passed.')
