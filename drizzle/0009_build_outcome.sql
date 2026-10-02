-- What actually happened in a build: rounds used, whether the agent called its
-- own verification gates and what they said, files written, cost and duration.
-- Nothing recorded this before, so a finished build left no evidence beyond
-- status = success — and every prompt or harness change was judged on one run.
ALTER TABLE "build_sessions"
ADD COLUMN IF NOT EXISTS "build_outcome" jsonb;
