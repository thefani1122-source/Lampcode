ALTER TABLE "projects"
ADD COLUMN IF NOT EXISTS "project_manifest" text;
