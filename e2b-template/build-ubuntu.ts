import 'dotenv/config'
import { Template } from 'e2b'
import { ubuntuTemplate } from './template.js'
import { ubuntuNextTemplate } from './template-nextjs-ubuntu.js'

// Separate candidate image IDs; neither can overwrite the production Vite template.
const TEMPLATE_ID = process.env['E2B_UBUNTU_TEMPLATE_ID'] ?? 'lampcode-vite-ubuntu24'
const CANDIDATE_ID_RE = /^lampcode-(?:vite|nextjs)-ubuntu24(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

async function main(): Promise<void> {
  if (!process.env['E2B_API_KEY']) {
    throw new Error('E2B_API_KEY missing. Put it in e2b-template/.env (gitignored) or a trusted Actions secret.')
  }
  if (!CANDIDATE_ID_RE.test(TEMPLATE_ID)) {
    throw new Error(`Refusing template ID "${TEMPLATE_ID}". Only lampcode-vite-ubuntu24 and lampcode-nextjs-ubuntu24 candidates are accepted.`)
  }

  const template = TEMPLATE_ID.includes('nextjs') ? ubuntuNextTemplate : ubuntuTemplate
  console.log(`Building isolated Ubuntu 24.04 ${TEMPLATE_ID.includes('nextjs') ? 'Next.js' : 'Vite'} candidate: ${TEMPLATE_ID}`)
  await Template.build(template, TEMPLATE_ID, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: (msg: unknown) => console.log(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  })

  console.log(`\nUbuntu template candidate built: ${TEMPLATE_ID}`)
  console.log('Next: run verify-template.ts with E2B_VERIFY_TEMPLATE_ID and E2B_EXPECT_FRAMEWORK set.')
  console.log('Production selectors and E2B_TEMPLATE_ID remain unchanged until a staging canary is approved.')
}

main().catch((err) => {
  console.error('Ubuntu template build failed:', err)
  process.exit(1)
})
