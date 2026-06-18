-- Add business_context column to projects table.
-- Stores optional app metadata used to enrich AI build prompts.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "business_context" jsonb NOT NULL DEFAULT '{}';
