/**
 * Structural regression checks for project/source/sandbox isolation.
 *
 * A repeated product name or prompt must never be used as a sandbox key.
 * Only the authenticated project ID scopes source files, build recovery and
 * the E2B lifecycle. The frontend's new-project composer allocates a project
 * before it starts a build; opening a saved card is the explicit resume path.
 */
import { readFileSync } from "node:fs";

const projects = readFileSync(new URL("../src/server/routes/projects.ts", import.meta.url), "utf8");
const storage = readFileSync(new URL("../src/storage/project-files.ts", import.meta.url), "utf8");
const preview = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

// New identity and owner boundary.
check(
  "every newly created project receives a fresh UUID and authenticated owner",
  /id:\\s*randomUUID\\(\\)/.test(projects) && /userId:\\s*authUser\\.id/.test(projects),
);
check(
  "project lookups are scoped by both project ID and authenticated user ID",
  /and\\(eq\\(projects\\.id,\\s*projectId\\),\\s*eq\\(projects\\.userId,\\s*userId\\)\\)/.test(projects),
);

// Persistent source is namespaced by project ID, never the display name/session.
check(
  "uploaded project files use a private project-ID prefix",
  /const storagePath = \`${projectId}\\/\${relPath}\`/.test(storage),
);
check(
  "file recovery lists only the requested project's storage prefix",
  /listAllStorageFiles\\(sb,\\s*projectId\\)/.test(storage),
);
check(
  "a restored relative path strips only the same project-ID prefix",
  /storagePath\\.slice\\(projectId\\.length \\+ 1\\)/.test(storage),
);

// Sandbox identity, framework guard and concurrent warm lock are project-scoped.
check(
  "Redis sandbox and framework keys include the exact project ID",
  /e2b:sandbox:\\${projectId}/.test(preview) && /e2b:framework:\\${projectId}/.test(preview),
);
check(
  "live sandboxes and in-flight acquisition locks are keyed by project ID",
  /new Map<string, Sandbox>\\(\\)/.test(preview) &&
    /warmingSandboxes = new Map<string, Promise<Sandbox>>\\(\\)/.test(preview) &&
    /sandboxes\\.get\\(projectId\\)/.test(preview),
);
check(
  "a sandbox is reused only when its saved framework matches the requested framework",
  /canReuseSandboxForFramework\\(savedFramework, framework\\)/.test(preview),
);

// A later build session may recover only this project's source.
check(
  "build recovery queries the current project ID and current owner",
  /eq\\(buildSessions\\.projectId,\\s*projectId\\)/.test(build) &&
    /eq\\(buildSessions\\.userId,\\s*userId\\)/.test(build),
);
check(
  "persistent file restore is passed the current project ID",
  /downloadProjectFiles\\(projectId\\)/.test(build),
);

console.log(`\\n${checks} project-isolation checks passed`);
