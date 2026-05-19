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

  const sql = postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 30,
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
