import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { config } from "../server/config.js";

// Lazy initialisation: defer connection until first use so the server can
// start and serve /health even when DATABASE_URL is not yet configured.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (_db !== null) return _db;

  if (!config.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in Railway → Variables.",
    );
  }

  const url = config.DATABASE_URL;

  // ── Detect Supabase pooler (port 6543 / pgBouncer) ──────────────────────────
  // The pooler runs in transaction mode and rejects prepared statements and
  // session-level commands, causing XX000 FATAL errors from Better Auth.
  // Always use the DIRECT connection (port 5432):
  //   postgresql://postgres:[PASSWORD]@db.kkyzhykycqydcguqdxye.supabase.co:5432/postgres
  const isPooler = url.includes(":6543") || url.includes("pooler.supabase.com");

  if (isPooler) {
    console.error(
      "[db] WARNING: DATABASE_URL is pointing at the Supabase POOLER (port 6543).\n" +
      "[db]   Better Auth issues session-level statements that cause XX000 FATAL on pgBouncer.\n" +
      "[db]   Switch DATABASE_URL to the DIRECT connection (port 5432):\n" +
      "[db]   postgresql://postgres:[PASSWORD]@db.kkyzhykycqydcguqdxye.supabase.co:5432/postgres",
    );
  }

  // Log host:port (no password) so it's visible in Railway logs.
  try {
    const parsed = new URL(url);
    console.log(
      `[db] connecting → ${parsed.hostname}:${parsed.port || "5432"} db=${parsed.pathname.slice(1)} pooler=${isPooler}`,
    );
  } catch {
    console.log("[db] connecting (could not parse DATABASE_URL for logging)");
  }

  const sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 30,
    // Disable prepared statements when on the pooler so at least simple
    // queries work. Session-level commands will still fail — only port 5432
    // fully resolves the XX000 FATAL error.
    prepare: !isPooler,
  });

  _db = drizzle(sql, { schema });
  return _db;
}

// Proxy that transparently forwards property access to the lazy instance.
export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
});

export type DB = typeof db;
