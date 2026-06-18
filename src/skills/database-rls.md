# Database & RLS Rules — Supabase

## RLS (Row Level Security) — Always Required

Every table MUST have:
1. CREATE TABLE with user_id column
2. ALTER TABLE ENABLE ROW LEVEL SECURITY
3. GRANT statements (always after CREATE)
4. CREATE POLICY for each operation needed

## The Pattern (never deviate)
```sql
-- Step 1: Create table
CREATE TABLE table_name (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  -- your columns here
  created_at timestamptz DEFAULT now()
);

-- Step 2: Enable RLS (always)
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;

-- Step 3: Grants (always — often forgotten)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON table_name TO authenticated;
GRANT ALL ON table_name TO service_role;

-- Step 4: Policies
CREATE POLICY "users_own_rows" ON table_name
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

## User Roles — Correct Pattern
NEVER store roles in profiles table directly.
Use a separate roles system:

```sql
-- WRONG:
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  role text DEFAULT 'user'  -- ← never do this
);

-- CORRECT:
CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) UNIQUE,
  role text NOT NULL DEFAULT 'user',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON user_roles TO authenticated;
GRANT ALL ON user_roles TO service_role;

-- Use security definer function for role check:
CREATE OR REPLACE FUNCTION get_user_role(uid uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT role FROM user_roles WHERE user_id = uid
$$;
```

## Multi-tenant Apps
When multiple user types exist (customer + admin):
```sql
-- Each data table has user_id
-- Admin policies use the role function:
CREATE POLICY "admins_see_all" ON orders
  FOR SELECT USING (
    get_user_role(auth.uid()) = 'admin'
    OR auth.uid() = user_id
  );
```

## TypeScript Types
Always generate matching types:
```typescript
// src/db/types.ts
export interface TableName {
  id: string
  user_id: string
  created_at: string
  // your fields
}
```

## Most Common RLS Mistakes
1. Forgot GRANT → authenticated user gets "permission denied"
2. Forgot ENABLE ROW LEVEL SECURITY → all data exposed
3. policy WITH CHECK missing → INSERT works, but shouldn't
4. Role in profiles table → security definer function needed
5. service_role grant missing → backend API can't write data
