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
  projects.includes("id: randomUUID(),") && projects.includes("userId: authUser.id,"),
);
check(
  "project lookups are scoped by both project ID and authenticated user ID",
  projects.includes("where(and(eq(projects.id, projectId), eq(projects.userId, userId)))"),
);

// Persistent source is namespaced by project ID, never the display name/session.
check(
  "uploaded project files use a private project-ID prefix",
  storage.includes("const storagePath = `${projectId}/${relPath}`;"),
);
check(
  "file recovery lists only the requested project's storage prefix",
  storage.includes("listAllStorageFiles(sb, projectId)"),
);
check(
  "a restored relative path strips only the same project-ID prefix",
  storage.includes("storagePath.slice(projectId.length + 1)"),
);

// Sandbox identity, framework guard and concurrent warm lock are project-scoped.
check(
  "Redis sandbox and framework keys include the exact project ID",
  preview.includes("return `e2b:sandbox:${projectId}`;") &&
    preview.includes("return `e2b:framework:${projectId}`;"),
);
check(
  "live sandboxes and in-flight acquisition locks are keyed by project ID",
  preview.includes("const sandboxes = new Map<string, Sandbox>();") &&
    preview.includes("const warmingSandboxes = new Map<string, Promise<Sandbox>>();") &&
    preview.includes("sandboxes.get(projectId)"),
);
check(
  "a sandbox is reused only when its saved framework matches the requested framework",
  preview.includes("canReuseSandboxForFramework(savedFramework, framework)"),
);

// A later build session may recover only this project's source.
check(
  "build recovery queries the current project ID and current owner",
  build.includes("eq(buildSessions.projectId, projectId)") &&
    build.includes("eq(buildSessions.userId, userId)"),
);
check(
  "persistent file restore is passed the current project ID",
  build.includes("downloadProjectFiles(projectId)"),
);

console.log(`\n${checks} project-isolation checks passed`);
