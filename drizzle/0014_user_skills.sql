CREATE TABLE IF NOT EXISTS "public"."user_skills" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "version" text NOT NULL DEFAULT '1.0.0',
  "revision" integer NOT NULL DEFAULT 1,
  "content" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resource_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "content_hash" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Enable default-deny immediately; no browser-facing policies are created.
ALTER TABLE "public"."user_skills" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_slug_idx"
  ON "public"."user_skills" ("user_id", "slug");

CREATE INDEX IF NOT EXISTS "user_skills_user_updated_idx"
  ON "public"."user_skills" ("user_id", "updated_at" DESC);

-- Upgrade tables created from an earlier migration revision without losing installed skills.
ALTER TABLE "public"."user_skills"
  ADD COLUMN IF NOT EXISTS "resources" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "public"."user_skills"
  ADD COLUMN IF NOT EXISTS "resource_paths" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill lightweight paths if a staging database had reference bodies from
-- an earlier revision before resource_paths was introduced.
UPDATE "public"."user_skills" AS skills
SET "resource_paths" = COALESCE(
  (
    SELECT jsonb_agg(resource_key ORDER BY resource_key)
    FROM jsonb_object_keys(skills."resources") AS resource_key
  ),
  '[]'::jsonb
)
WHERE skills."resource_paths" = '[]'::jsonb
  AND skills."resources" <> '{}'::jsonb;
-- Skill contents can include private engineering workflows and proprietary guidance.
-- The frontend ships the Supabase anon key, so direct PostgREST access must be
-- denied. LampCode reads/writes this table only through its authenticated API
-- using the trusted backend DATABASE_URL; no client-facing policy is needed.
-- Keep RLS enabled with zero policies unless a separately reviewed access path
-- is introduced. Do not expose this table directly to browser clients.
