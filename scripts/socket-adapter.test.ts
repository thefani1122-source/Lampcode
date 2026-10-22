/**
 * Cases for the Socket.IO Redis adapter switch. Run by `npm test`.
 *
 * WHY THIS IS A SWITCH AND NOT A CONSTANT. The adapter exists for one reason:
 * letting several instances of this server share a broadcast. It costs one
 * Redis PUBLISH per emit — and this server streams model output over the
 * socket, so a single build is thousands of publishes. Against a Redis billed
 * per command (Upstash's free tier is 500k a month) that is the whole
 * allowance in days, bought for nothing, because a one-instance deployment has
 * nobody to broadcast to.
 *
 * THE DEFAULT IS THE CAREFUL PART. It stays TRUE. Whether production runs one
 * replica or two is not something this code can see, and switching the adapter
 * off under a second replica would silently stop that replica's users
 * receiving build events — a bug nobody would attribute to this change. So the
 * saving is opt-in, and the cases below pin the default rather than the
 * saving.
 */

import { readFileSync } from "node:fs";

let checks = 0;
let failures = 0;
function ok(name: string, condition: boolean): void {
  checks++;
  if (condition) console.log(`✔ ${name}`);
  else { failures++; console.error(`✘ ${name}`); }
}

const configSrc = readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../src/websocket/server.ts", import.meta.url), "utf8");
const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

// The parser, applied exactly as config.ts declares it. Copied rather than
// imported for the same reason env-example.test.ts copies: importing config.ts
// validates the real environment for what is a question about a string.
const parse = (v: string | undefined): boolean =>
  v === undefined || v === "" ? true : !(v === "false" || v === "0");

console.log("\n— the default protects a deployment nobody can see —");
ok("unset means ON, so no running deployment changes", parse(undefined) === true);
ok("empty means ON", parse("") === true);
ok('"false" turns it off', parse("false") === false);
ok('"0" turns it off', parse("0") === false);
ok('"true" keeps it on', parse("true") === true);

// z.coerce.boolean() reads "false" as true, so a var set to turn this OFF
// would have turned it ON. The same trap AGENTIC_BUILD_ENABLED documents.
ok("the schema parses the string itself, not with z.coerce.boolean",
  /SOCKETIO_REDIS_ADAPTER[\s\S]{0,400}v === "false" \|\| v === "0"/.test(configSrc));
ok("and it is declared in the schema", /^ {2}SOCKETIO_REDIS_ADAPTER:/m.test(configSrc));

console.log("\n— the server honours it —");
ok("the adapter is attached only when it is on", serverSrc.includes("if (config.SOCKETIO_REDIS_ADAPTER) {"));
ok("createAdapter is inside that branch",
  serverSrc.indexOf("if (config.SOCKETIO_REDIS_ADAPTER)") < serverSrc.indexOf("this.io.adapter(createAdapter"));

// Silence here would be the bug: correct for one instance, wrong for two, and
// the log is the only place anyone would find out which is running.
ok("turning it off is logged, not silent", serverSrc.includes("SOCKETIO_REDIS_ADAPTER=false"));
ok("and the log says what it would break", serverSrc.includes("second replica would not receive"));
ok("the failure path still falls back rather than crashing",
  serverSrc.includes("falling back to in-memory adapter"));

// The offline queue on these two clients is load-bearing: RedisAdapter calls
// psubscribe() before the socket has opened and does not handle the rejection.
ok("the offline-queue exception survives the change",
  (serverSrc.match(/createRedis\(\{ enableOfflineQueue: true \}\)/g) ?? []).length === 2);

console.log("\n— it is documented where someone deploying would look —");
ok("the var is in .env.example", example.includes("SOCKETIO_REDIS_ADAPTER"));
ok("commented out, so copying the file changes nothing", example.includes("# SOCKETIO_REDIS_ADAPTER=false"));
ok("it says what the adapter costs", example.includes("PUBLISH per emit"));
ok("and what turning it off would break", example.includes("stop receiving build events")
  || example.includes("stop receiving") || example.includes("second replica"));
ok("REDIS_URL is documented as host-agnostic, so a move is one variable",
  example.includes("rediss://"));

console.log(`\n${checks} socket-adapter checks, ${failures} failed`);
if (failures > 0) process.exit(1);
