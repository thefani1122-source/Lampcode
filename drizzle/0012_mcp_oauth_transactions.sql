CREATE TABLE IF NOT EXISTS "public"."mcp_oauth_transactions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "provider_slug" text NOT NULL,
  "server_url" text NOT NULL,
  "state_hash" text NOT NULL,
  "encrypted_data" text NOT NULL,
  "encrypted_data_iv" text NOT NULL,
  "encrypted_data_tag" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_transactions_state_hash_idx"
  ON "public"."mcp_oauth_transactions" ("state_hash");
ALTER TABLE "public"."mcp_oauth_transactions" ENABLE ROW LEVEL SECURITY;

