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

  // ── Detect Supabase pooler (port 6543 / pooler.supabase.com) ────────────────
  // RECOMMENDED on Railway: use the POOLER connection string.
  //
  // Supabase's direct host (db.*.supabase.co) resolves to an IPv6 address
  // (2406:da12:…) which Railway containers cannot reach (no IPv6 outbound).
  // The pooler host (aws-0-*.pooler.supabase.com) resolves to IPv4 only and
  // is reachable from Railway without any special network configuration.
  //
  // Previously the pooler was avoided because Better Auth issued session-level
  // SQL statements that pgBouncer (transaction mode) rejects with XX000 FATAL.
  // Better Auth has been removed — Drizzle ORM queries are stateless and work
  // correctly through the pooler with prepared statements disabled.
  //
  // Pooler connection string format (from Supabase → Settings → Database):
  //   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
  //
  // Direct connection (IPv6 — DO NOT use on Railway):
  //   postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
  const isPooler = url.includes(":6543") || url.includes("pooler.supabase.com");

  if (!isPooler) {
    console.warn(
      "[db] WARNING: DATABASE_URL is pointing at the Supabase DIRECT connection.\n" +
      "[db]   The direct host (db.*.supabase.co) resolves to IPv6 on Railway, causing\n" +
      "[db]   ENETUNREACH errors. Switch to the POOLER connection string:\n" +
      "[db]   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres\n" +
      "[db]   Find it in: Supabase Dashboard → Settings → Database → Connection string → Transaction pooler",
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
