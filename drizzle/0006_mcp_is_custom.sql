ALTER TABLE "user_mcp_connections"
ADD COLUMN IF NOT EXISTS "is_custom" boolean DEFAULT false;
