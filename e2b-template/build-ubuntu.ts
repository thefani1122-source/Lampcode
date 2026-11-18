import 'dotenv/config'
import { Template } from 'e2b'
import { ubuntuTemplate } from './template.js'

// Build a separate candidate image. This script refuses to target the current
// production template ID so a POC cannot silently replace the live baseline.
const TEMPLATE_ID = process.env['E2B_UBUNTU_TEMPLATE_ID'] ?? 'lampcode-vite-ubuntu24'
const CANDIDATE_ID_RE = /^lampcode-vite-ubuntu24(?:-[a-z0-9-]+)?$/

async function main(): Promise<void> {
  if (!process.env['E2B_API_KEY']) {
    console.error(
      'E2B_API_KEY missing. Add it to e2b-template/.env (gitignored) or provide it as an environment secret.',
    )
    process.exit(1)
  }
  if (!CANDIDATE_ID_RE.test(TEMPLATE_ID)) {
    throw new Error(
      `Refusing to build template ID "${TEMPLATE_ID}". Candidate IDs must start with "lampcode-vite-ubuntu24"; production ID "lampcode-vite" is never accepted here.`,
    )
  }

  console.log(`Building isolated Ubuntu 24.04 candidate: ${TEMPLATE_ID}`)
  await Template.build(ubuntuTemplate, TEMPLATE_ID, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: (msg: unknown) =>
      console.log(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  })

  console.log(`\nUbuntu template candidate built: ${TEMPLATE_ID}`)
  console.log('Next: verify the live sandbox with E2B_VERIFY_TEMPLATE_ID and E2B_EXPECT_UBUNTU=true.')
  console.log('Production still uses its existing E2B_TEMPLATE_ID until a staged canary is approved.')
}

main().catch((err) => {
  console.error('Ubuntu template build failed:', err)
  process.exit(1)
})
