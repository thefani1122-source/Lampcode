CREATE TABLE IF NOT EXISTS "public"."user_plugins" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "plugin_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "version" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "publisher" text NOT NULL,
  "license" text NOT NULL,
  "repository" text NOT NULL,
  "source_commit" text NOT NULL,
  "manifest" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "files" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "previous_versions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "content_hash" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "installed_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Default-deny: imported package content is only accessible through the
-- authenticated LampCode backend. Do not add browser/PostgREST policies.
ALTER TABLE "public"."user_plugins" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS "user_plugins_user_plugin_idx"
  ON "public"."user_plugins" ("user_id", "plugin_id");

CREATE INDEX IF NOT EXISTS "user_plugins_user_updated_idx"
  ON "public"."user_plugins" ("user_id", "updated_at" DESC);
