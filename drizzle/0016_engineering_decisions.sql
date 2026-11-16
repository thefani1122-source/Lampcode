CREATE TABLE IF NOT EXISTS "public"."engineering_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "build_session_id" text,
  "change_type" text NOT NULL,
  "user_requirement" text NOT NULL,
  "observed_failure" text,
  "root_cause" text,
  "rationale" text NOT NULL,
  "decision" text NOT NULL,
  "implementation" text NOT NULL,
  "affected_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "affected_symbols" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "diff_summary" text,
  "verification_result" text,
  "verification_status" text NOT NULL DEFAULT 'unverified',
  "confidence" text NOT NULL DEFAULT 'medium',
  "provenance" text NOT NULL DEFAULT 'agent_execution',
  "superseded_by" text,
  "supersedes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "public"."engineering_decisions" ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS "engineering_decisions_project_idx"
  ON "public"."engineering_decisions" ("project_id");

CREATE INDEX IF NOT EXISTS "engineering_decisions_project_created_idx"
  ON "public"."engineering_decisions" ("project_id", "created_at" DESC);
