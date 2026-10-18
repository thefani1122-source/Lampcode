/**
 * "This is a full-stack build — connect your Supabase."
 *
 * WHY THIS IS A GATE AND NOT A SUGGESTION — measured 2026-10-17, HISTORY.md.
 * The shared preview project holds no app tables and never will: `build.ts`
 * applies the generated `schema.sql` only against a Supabase the person
 * connected themselves, correctly refusing to run model-written SQL on a
 * database every user shares. So a full-stack build without a connected
 * project has nowhere to put its data, and the failure is silent — the
 * generated error handling turns a missing table into an empty list, so the
 * app looks finished and holds nothing.
 *
 * The moment to ask is BEFORE generation. The sandbox `.env` is written during
 * prewarm, so a project connected halfway through a build arrives too late to
 * change what the app is pointed at. That is why this blocks rather than
 * notifying: a notification the person reads after the build is a notification
 * about something that can no longer be fixed.
 *
 * Nothing here decides anything on the person's behalf. Declining is a listed,
 * first-class option, and a timeout means the build proceeds exactly as it does
 * today — the gate can only ever add a database, never withhold a build.
 *
 * The wait itself is `pending-answers.ts`, unchanged: same 10-minute window,
 * same session-identity check, same sweep on disconnect, and the same frontend
 * prompt that `ask_user` already renders.
 */

export interface DatabaseQuestionOption {
  label: string;
  description: string;
  recommended?: boolean;
  /** Tells the frontend to open the connect flow instead of answering with the
   *  label. Unknown actions are ignored there, so an old client still shows a
   *  plain button and the person can answer in their own words. */
  action?: "connect-supabase";
}

export const CONNECT_LABEL = "Connect Supabase";
export const DECLINE_LABEL = "Continue without a database";

/**
 * What the person is actually asked. Written for someone who did not ask to
 * learn what a schema is: it says what will happen to THEIR app, not what the
 * build system cannot do.
 */
export function buildDatabaseQuestion(): { question: string; options: DatabaseQuestionOption[] } {
  return {
    question:
      "This app needs to save data, and it needs your own database to save it in. " +
      "Connect a Supabase project and I will create its tables for you.",
    options: [
      {
        label: CONNECT_LABEL,
        description:
          "Opens the connect page. Your project, your data — I will set up the tables the app needs. " +
          "Free on Supabase, and it takes about a minute.",
        recommended: true,
        action: "connect-supabase",
      },
      {
        label: DECLINE_LABEL,
        description:
          "I will still build the app and you can see every page. Anything you type into it will not be kept, " +
          "and lists will come back empty.",
      },
    ],
  };
}

/**
 * What the answer meant. Deliberately generous about the connect case and
 * strict about nothing: the real decision is made by re-reading the database,
 * not by reading this. A person who types "done" or "connected it" or clicks
 * the button all land in the same place, and if they are wrong the re-check
 * catches it.
 */
export function interpretDatabaseAnswer(answer: string | null): "connect" | "decline" | "unclear" {
  if (answer === null) return "unclear";
  const a = answer.trim().toLowerCase();
  if (a.length === 0) return "unclear";

  // Checked first: "don't connect anything" contains "connect".
  if (
    a === DECLINE_LABEL.toLowerCase() ||
    /\b(no|skip|later|without|don'?t|do not|not now|nahi|baad)\b/.test(a)
  ) {
    return "decline";
  }
  if (
    a === CONNECT_LABEL.toLowerCase() ||
    /\b(connect|connected|done|yes|ok|okay|ready|supabase|haan|kar diya)\b/.test(a)
  ) {
    return "connect";
  }
  return "unclear";
}

// Asked at most once per PERSON per process — not per project.
//
// It was keyed on projectId at first, which read as "ask once per app" and
// behaved as "ask every time", because a new app is a new project. Someone
// trying three ideas in an afternoon was asked three times for a database they
// had already decided about, which is how a gate becomes something people
// click past without reading.
//
// The person is the right key: the decision is about their account, the
// integration is stored against their account, and once they connect one, the
// caller's `!userSupa` check means this is never reached again at all.
//
// An in-process Set, like `pending-answers.ts`: a deploy forgetting a refusal
// costs one repeated question, which is cheaper than a column and a migration.
const asked = new Set<string>();

/** True the first time this person is asked in this process. */
export function shouldAskForDatabase(userId: string): boolean {
  if (asked.has(userId)) return false;
  asked.add(userId);
  return true;
}

/** Test seam — nothing in the server calls this. */
export function resetDatabasePromptMemory(): void {
  asked.clear();
}
