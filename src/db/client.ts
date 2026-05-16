import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { config } from "../server/config.js";

const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 30,
});

export const db = drizzle(sql, { schema });
export type DB = typeof db;
