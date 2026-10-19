-- The ordered record of what a build DID, as it happened (C1/C2).
--
-- build_outcome answers "how did it end"; this answers "in what order". The
-- difference matters because every stale-verdict bug in this product is an
-- ordering bug: a gate passed, then a file was written, and the record kept
-- only the verdict. A fold over these rows (src/verify/outcome-projection.ts)
-- derives the outcome instead of a mutable object being patched as the build
-- goes, so staleness is DERIVABLE rather than remembered.
--
-- Deliberately narrow payloads: tool NAMES, counts, gate verdicts, file paths.
-- No tool responses, no model output, no credentials — a tool result can carry
-- an access token and this table is not where one may end up.
CREATE TABLE IF NOT EXISTS "build_events" (
  -- uuid, not text: build_sessions.id is uuid in the database even though
  -- schema.ts declares it as text, and a text column cannot carry a foreign
  -- key to a uuid one. Same note as build_messages, same reason.
  "id"         uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "build_sessions"("id") ON DELETE CASCADE,
  -- Monotonic within a session, assigned by the recorder. Timestamps collide
  -- inside a millisecond; the projection needs a total order it can trust.
  "seq"        integer NOT NULL,
  "type"       text NOT NULL,
  "payload"    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- The order IS the data, so a duplicate seq is corruption, not a nuisance.
CREATE UNIQUE INDEX IF NOT EXISTS "build_events_session_seq_idx"
  ON "build_events" ("session_id", "seq");

-- Row-level security ON from creation, with no policy, which denies every
-- anon/authenticated request outright. The only reader and writer is the
-- backend over DATABASE_URL, which is not subject to RLS.
--
-- This is deliberate and it is the lesson from build_messages, which shipped
-- without it and sat open with 3253 rows of user prompts and model output
-- reachable by the anon key that ships in the frontend bundle. A new table
-- gets this in the same migration that creates it, not in a later one.
ALTER TABLE "build_events" ENABLE ROW LEVEL SECURITY;
