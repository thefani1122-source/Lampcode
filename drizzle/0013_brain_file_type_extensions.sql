-- Align the Brain enum with the API/schema without relying on PostgreSQL's
-- ALTER TYPE ... ADD VALUE commit boundary. Drizzle runs pending migrations in
-- one transaction, so replacing the type lets later migrations use the new
-- labels in that same transaction safely.
CREATE TYPE "public"."brain_file_type_next" AS ENUM(
  'CONTRACT',
  'DB_SCHEMA',
  'API_CONTRACTS',
  'CURRENT_STATE',
  'DEPLOY_CHECKLIST',
  'SECURITY_CHECKLIST',
  'CONNECTION_CHECKLIST',
  'PROVENANCE_LOG'
);

ALTER TABLE "public"."shared_brain_files"
  ALTER COLUMN "file_type" TYPE "public"."brain_file_type_next"
  USING "file_type"::text::"public"."brain_file_type_next";

DROP TYPE "public"."brain_file_type";
ALTER TYPE "public"."brain_file_type_next" RENAME TO "brain_file_type";
