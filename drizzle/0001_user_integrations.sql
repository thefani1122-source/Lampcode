CREATE TYPE "public"."user_integration_provider" AS ENUM('supabase', 'vercel', 'github', 'railway');
CREATE TYPE "public"."user_integration_status" AS ENUM('connected', 'disconnected', 'error');

CREATE TABLE "user_integrations" (
  "id"             text PRIMARY KEY NOT NULL,
  "user_id"        text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider"       "user_integration_provider" NOT NULL,
  "status"         "user_integration_status" NOT NULL DEFAULT 'disconnected',
  "config"         jsonb NOT NULL DEFAULT '{}',
  "last_tested_at" timestamp,
  "last_error"     text,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "user_integrations_user_provider_idx" ON "user_integrations"("user_id", "provider");
