import {
  RECOVERABLE_BUILD_STATUSES,
  isRecoverableBuildSession,
  hasRecoverableAppEntrypoint,
} from "../src/verify/build-recovery.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.error(`FAIL: ${name} — got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

check("successful sessions with an output directory are recoverable", isRecoverableBuildSession("success", "/workspace/p/s/frontend"), true);
check("completed sessions with an output directory are recoverable", isRecoverableBuildSession("completed", "/workspace/p/s/frontend"), true);
check("failed verification sessions with an output directory are recoverable", isRecoverableBuildSession("failed", "/workspace/p/s/frontend"), true);
check("failed sessions without a saved directory are not recoverable", isRecoverableBuildSession("failed", null), false);
check("running sessions are not treated as stable recovery baselines", isRecoverableBuildSession("running", "/workspace/p/s/frontend"), false);
check("the query only admits terminal artifact-bearing statuses", RECOVERABLE_BUILD_STATUSES, ["success", "completed", "failed"]);

check("a React app entrypoint makes a storage snapshot recoverable", hasRecoverableAppEntrypoint({ "src/App.tsx": "export default function App() { return null }" }), true);
check("a Next app entrypoint makes a storage snapshot recoverable", hasRecoverableAppEntrypoint({ "app/page.tsx": "export default function Page() { return null }" }), true);
check("a TanStack app entrypoint makes a storage snapshot recoverable", hasRecoverableAppEntrypoint({ "app/routes/index.tsx": "export default function Index() { return null }" }), true);
check("a snapshot containing only security helper files is not an existing app", hasRecoverableAppEntrypoint({ "src/lib/security/csrf.ts": "export const token = 1" }), false);
check("an empty App.tsx is not a recoverable entrypoint", hasRecoverableAppEntrypoint({ "src/App.tsx": "  " }), false);

console.log(failures === 0 ? "\nAll build-recovery cases passed." : `\n${failures} build-recovery case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
