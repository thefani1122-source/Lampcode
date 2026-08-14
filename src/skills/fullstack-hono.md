---
name: fullstack-hono
description: Hono + Supabase fullstack architecture — required file layout, CORS setup, the API-client fetch pattern, and the RLS+GRANT SQL convention for every table.
---

# Fullstack Build — Hono + Supabase

## Architecture
Frontend: React (Vite, port 5173)
Backend: Hono (Node, port 3001)
Database: Supabase (PostgreSQL)
Preview: E2B sandbox (both run together)

## Required Files (all must be present)
src/index.tsx              → React entry
src/App.tsx                → Frontend app
src/styles.css             → Styles
src/lib/api.ts             → API client (fetch wrappers)
src/lib/supabase.ts        → Supabase client
src/server/index.ts        → Hono server entry
src/server/routes/api.ts   → API routes
src/db/schema.sql          → Database schema
src/db/types.ts            → TypeScript types
package.json               → All dependencies

## Backend Rules (Hono)
```typescript
// src/server/index.ts — always this structure:
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"

const app = new Hono()
app.use("*", cors({ origin: "*" }))

// Mount routes
import { apiRoutes } from "./routes/api"
app.route("/api", apiRoutes)

serve({ fetch: app.fetch, port: 3001 })
```

Always add CORS — frontend is on different port.

## Frontend API Calls
```typescript
// src/lib/api.ts — always this pattern:
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001"

export async function fetchData(path: string) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

## Supabase Schema Rules
EVERY table must have:
- id uuid PRIMARY KEY DEFAULT gen_random_uuid()
- created_at timestamptz DEFAULT now()
- user_id uuid REFERENCES auth.users(id)
- ROW LEVEL SECURITY enabled
- GRANT statements after CREATE TABLE

```sql
-- Always this pattern:
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE items ENABLE ROW LEVEL SECURITY;

-- GRANT statements (never skip these):
GRANT ALL ON items TO authenticated;
GRANT ALL ON items TO service_role;

-- RLS policies:
CREATE POLICY "users_own_items" ON items
  FOR ALL USING (auth.uid() = user_id);
```

## Common Fullstack Mistakes to Avoid
1. Missing CORS → frontend can't reach backend
2. Missing GRANT statements → permission denied errors
3. Missing ROW LEVEL SECURITY → security hole
4. Hardcoded localhost in frontend → breaks in E2B
5. Missing error handling in API routes → silent failures
6. user_id stored in profiles table (WRONG) →
   store roles separately, user_id in each table
