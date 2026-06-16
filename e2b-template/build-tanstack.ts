import 'dotenv/config'
import { Template } from 'e2b'
import { template } from './template-tanstack.js'

// ── Build + push the "lampcode-tanstack" template to your E2B account ─────────
// Run:  npx tsx build-tanstack.ts
// Needs a local .env in this folder:  E2B_API_KEY=e2b_...  (https://e2b.dev/dashboard → Keys)

async function main() {
  if (!process.env['E2B_API_KEY']) {
    console.error(
      '❌ E2B_API_KEY missing.\n' +
        '   Create a .env file in this folder containing:\n' +
        '   E2B_API_KEY=e2b_your_key_here   (from https://e2b.dev/dashboard → Keys)',
    )
    process.exit(1)
  }

  await Template.build(template, 'lampcode-tanstack', {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: (msg: unknown) =>
      console.log(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  })

  console.log('\n✅ Template built: lampcode-tanstack')
  console.log('   Set TANSTACK_TEMPLATE_ID=lampcode-tanstack in your backend env (Railway + .env).')
}

main().catch((err) => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})
