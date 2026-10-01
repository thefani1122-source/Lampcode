DO $$ BEGIN
  CREATE TYPE "build_message_role" AS ENUM ('user', 'thinking', 'tool', 'assistant', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "build_messages" (
  -- uuid, not text: build_sessions.id and projects.id are uuid in the database
  -- even though schema.ts declares them as text, and a text column cannot carry
  -- a foreign key to a uuid one.
  "id"         uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "build_sessions"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "seq"        integer NOT NULL,
  "role"       "build_message_role" NOT NULL,
  "content"    text NOT NULL,
  "metadata"   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "build_messages_session_seq_idx"
  ON "build_messages" ("session_id", "seq");

-- Reading a session's history is the only query this table serves.
CREATE INDEX IF NOT EXISTS "build_messages_session_created_idx"
  ON "build_messages" ("session_id", "created_at");
