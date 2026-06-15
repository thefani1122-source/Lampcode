-- Add the new MCP provider integrations to the user_integration_provider enum.
-- (The encryptedCreds / meta config fields are stored in the existing jsonb
-- column, so no column change is needed.)
-- Run these in your platform DB (Supabase SQL editor) — each is additive & safe.
ALTER TYPE "user_integration_provider" ADD VALUE IF NOT EXISTS 'wordpress';
ALTER TYPE "user_integration_provider" ADD VALUE IF NOT EXISTS 'shopify';
ALTER TYPE "user_integration_provider" ADD VALUE IF NOT EXISTS 'make';
ALTER TYPE "user_integration_provider" ADD VALUE IF NOT EXISTS 'n8n';
ALTER TYPE "user_integration_provider" ADD VALUE IF NOT EXISTS 'zapier';
