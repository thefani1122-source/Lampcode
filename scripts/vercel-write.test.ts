/**
 * vercel_write rides the same shared write approval gate as every other write
 * tool, so the guarantees tested here mirror github-write.test.ts: the tool is
 * never reachable without the gate, it is offered only when a token exists,
 * and validation speaks before any network call is made.
 */
import { VERCEL_WRITE_DEFS, buildVercelWriteRegistry, vercelWriteHandler } from "../src/agents/tools/vercel-writes.js";
import { vercelQueryHandler } from "../src/agents/tools/vercel-query.js";

let failures = 0;
function ok(name: string, value: boolean): void {
  if (value) console.log(`ok ${name}`);
  else { failures++; console.log(`FAIL ${name}`); }
}

function ctxWithToken(): never {
  return { deploy: { vercelToken: "vtest", projectName: "lampcode-app" } } as never;
}

ok("vercel_write is defined", VERCEL_WRITE_DEFS.some((t) => t.name === "vercel_write"));


// The registry exists only when a Vercel token is stored (fail closed).
ok("no token means no write tools offered", buildVercelWriteRegistry(undefined).size === 0);
const registry = buildVercelWriteRegistry("vtest");
ok("vercel_write offered with a token", registry.size === 1);
ok("vercel_write is approval tier", registry.get("vercel_write")?.tier === "approval");
ok("write meta carries a local executor", typeof registry.get("vercel_write")?.localExecute === "function");
ok("write meta declares the vercel server", registry.get("vercel_write")?.serverSlug === "vercel");

// Validation paths speak before any network call is made.
const noToken = await vercelWriteHandler({ action: "rollback", deployment: "dpl_1" }, {} as never);
ok("no token is refused", noToken.includes("not connected"));
const noDeployment = await vercelWriteHandler({ action: "rollback" }, ctxWithToken());
ok("rollback without a deployment is refused", noDeployment.includes("deployment"));
const noProject = await vercelWriteHandler({ action: "rollback", deployment: "dpl_1" }, { deploy: { vercelToken: "vtest" } } as never);
ok("rollback without a project is refused", noProject.includes("project"));
const unknown = await vercelWriteHandler({ action: "delete_project", project: "p" }, ctxWithToken());
ok("unknown write actions are refused", unknown.includes("Unknown action"));
const deleteOffered = JSON.stringify(VERCEL_WRITE_DEFS).toLowerCase();
ok("deletion is not offered", !deleteOffered.includes("delete_project"));

// The query tool keeps answering read-only questions with the same credential.
const queryNoToken = await vercelQueryHandler({}, {} as never);
ok("query without a token is refused", queryNoToken.includes("not connected"));

if (failures > 0) { console.log(`${failures} vercel-write checks FAILED`); process.exit(1); }
console.log("All vercel-write checks passed.");
