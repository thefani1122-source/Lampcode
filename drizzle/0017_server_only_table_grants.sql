-- These tables contain private imported skill/plugin content and engineering history.
-- LampCode accesses them only through the trusted backend DATABASE_URL.
-- RLS remains enabled with no policies; revoke API-role table privileges as a
-- second boundary so a future accidental permissive policy cannot expose them.
REVOKE ALL PRIVILEGES ON TABLE
  public.user_skills,
  public.user_plugins,
  public.engineering_decisions
FROM PUBLIC, anon, authenticated;
