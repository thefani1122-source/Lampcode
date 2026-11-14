CREATE TABLE IF NOT EXISTS "public"."user_skills" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "version" text NOT NULL DEFAULT '1.0.0',
  "revision" integer NOT NULL DEFAULT 1,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_slug_idx"
  ON "public"."user_skills" ("user_id", "slug");

CREATE INDEX IF NOT EXISTS "user_skills_user_updated_idx"
  ON "public"."user_skills" ("user_id", "updated_at" DESC);
