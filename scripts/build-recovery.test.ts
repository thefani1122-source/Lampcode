import {
  RECOVERABLE_BUILD_STATUSES,
  isRecoverableBuildSession,
  hasRecoverableAppEntrypoint,
  mergePersistedBuildFiles,
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

// Multi-dispatch agentic builds can persist files that are absent from the
// final dispatch's generatedFiles map. Reconcile the whole persisted source
// tree before validating the entrypoint.
const reconciled = mergePersistedBuildFiles(
  [{ path: "src/views/DashboardPage.tsx", code: "latest dashboard" }],
  {
    "src/App.tsx": "export default function App() { return null }",
    "src/index.tsx": "createRoot()",
    "src/views/DashboardPage.tsx": "older dashboard",
    ".preview/thumbnail.png": "binary screenshot bytes",
  },
);
check("persisted App.tsx is recovered when the final dispatch only changed a page", reconciled.some((file) => file.path === "src/App.tsx"), true);
check("current dispatch content overrides the older persisted copy", reconciled.find((file) => file.path === "src/views/DashboardPage.tsx")?.code, "latest dashboard");
check("preview thumbnails are not treated as source files", reconciled.some((file) => file.path.startsWith(".preview/")), false);
check("reconciled source contains a recoverable app entrypoint", hasRecoverableAppEntrypoint(Object.fromEntries(reconciled.map((file) => [file.path, file.code]))), true);

const withDeletion = mergePersistedBuildFiles(
  [{ path: "src/App.tsx", code: "current App" }],
  { "src/App.tsx": "stale stored App", "src/OldPage.tsx": "old page" },
  ["src/App.tsx"],
);
check("successful deletions are not resurrected from persisted storage", withDeletion.some((file) => file.path === "src/App.tsx"), false);
check("unrelated persisted files survive reconciliation", withDeletion.some((file) => file.path === "src/OldPage.tsx"), true);
const unsafe = mergePersistedBuildFiles([], {
  "../secrets.txt": "no",
  "/absolute.ts": "no",
  "src/../escape.ts": "no",
  "src/Safe.tsx": "yes",
});
check("unsafe persisted paths are excluded", unsafe.map((file) => file.path), ["src/Safe.tsx"]);

console.log(failures === 0 ? "\nAll build-recovery cases passed." : `\n${failures} build-recovery case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
