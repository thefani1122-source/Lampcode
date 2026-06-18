# Supabase Row Level Security Patterns

## Always Enable RLS
- Run `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` on every user-facing table
- Without explicit policies, RLS blocks all access — add policies for each operation needed
- The service role key bypasses RLS — only use it server-side, never expose it to the client

## Standard Policy Patterns

### User-owned rows (most common)
```sql
-- Allow users to read only their own rows
CREATE POLICY "users_select_own" ON table_name
  FOR SELECT USING (auth.uid() = user_id);

-- Allow users to insert rows for themselves only
CREATE POLICY "users_insert_own" ON table_name
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow users to update only their own rows
CREATE POLICY "users_update_own" ON table_name
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Allow users to delete only their own rows
CREATE POLICY "users_delete_own" ON table_name
  FOR DELETE USING (auth.uid() = user_id);
```

### Public read, authenticated write
```sql
CREATE POLICY "public_read" ON table_name FOR SELECT USING (true);
CREATE POLICY "auth_insert"  ON table_name FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
```

### Team/org membership
```sql
-- Access via junction table
CREATE POLICY "team_members_read" ON resources
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.team_id = resources.team_id
        AND team_members.user_id = auth.uid()
    )
  );
```

## Key Rules
- Always write separate policies for SELECT, INSERT, UPDATE, DELETE — never combine them
- `USING` controls which rows are visible (SELECT/UPDATE/DELETE)
- `WITH CHECK` controls which rows can be written (INSERT/UPDATE)
- Test each policy explicitly in the Supabase SQL editor with `SET LOCAL role = authenticated; SET LOCAL request.jwt.claims TO '{"sub":"<user-id>"}'`
- Never store sensitive data in columns without RLS protection
- Index the `user_id` / `team_id` column used in policies to avoid full table scans
