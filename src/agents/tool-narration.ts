/**
 * The one place a tool call is turned into words a person can read.
 *
 * The chat used to show the model's raw reasoning and a bare snake_case tool
 * name, which is why the build looked unreadable even when it went well. Both
 * tenses live here, together, so the live status line and the finished row can
 * never describe the same call differently — and so the frontend never has to
 * guess a verb from a tool name it does not own.
 *
 * Phrasing rule: say what it did for the USER, not what it did to the repo.
 * `find_wiring_gaps` is "Checked every button and form", not "Ran the wiring
 * analyser". The checks are the product's best argument; naming them in
 * maintainer language is how they stayed invisible.
 */

export interface ToolNarration {
  /** Finished row: "Read src/App.tsx". */
  label: string;
  /** Live line, present tense, no ellipsis: "Reading src/App.tsx". */
  active: string;
}

interface Phrase {
  past: string;
  present: string;
  /** Argument holding the thing to name after the verb. */
  arg?: string;
  /** Argument holding a list whose LENGTH is named: "Wrote 19 files". */
  countArg?: string;
  countNoun?: string;
}

const PHRASES: Record<string, Phrase> = {
  read_file: { past: "Read", present: "Reading", arg: "path" },
  read_project_file: { past: "Read", present: "Reading", arg: "path" },
  write_files: {
    past: "Wrote",
    present: "Writing",
    countArg: "files",
    countNoun: "file",
  },
  edit_file: { past: "Edited", present: "Editing", arg: "path" },
  delete_file: { past: "Deleted", present: "Deleting", arg: "path" },
  list_files: { past: "Listed the files", present: "Listing the files" },
  search_code: { past: "Searched the code for", present: "Searching the code for", arg: "query" },
  code_intel: { past: "Looked up", present: "Looking up", arg: "symbol" },
  impact_analysis: { past: "Checked what this affects", present: "Checking what this affects" },

  // The gates. Plain language on purpose: these are the lines that tell a
  // person the build was checked rather than hoped over.
  check_page: { past: "Checked that the app opens", present: "Checking that the app opens" },
  check_types: { past: "Checked that the code compiles", present: "Checking that the code compiles" },
  run_tests: { past: "Ran the tests", present: "Running the tests" },
  find_wiring_gaps: {
    past: "Checked every button and form",
    present: "Checking every button and form",
  },
  find_dead_code: { past: "Looked for unused code", present: "Looking for unused code" },
  review_code: { past: "Reviewed the code", present: "Reviewing the code" },
  browser_interact: {
    past: "Tried the controls in a browser",
    present: "Trying the controls in a browser",
  },
  look_at_page: { past: "Looked at the page", present: "Looking at the page" },
  check_render: { past: "Checked every page renders", present: "Checking every page renders" },

  read_logs: { past: "Read the logs", present: "Reading the logs" },
  shell: { past: "Ran a command", present: "Running a command" },
  fetch_reference: { past: "Read the documentation", present: "Reading the documentation" },
  web_search: { past: "Searched the web for", present: "Searching the web for", arg: "query" },
  load_skill: { past: "Loaded extra guidance", present: "Loading extra guidance" },

  checkpoint: { past: "Saved a checkpoint", present: "Saving a checkpoint" },
  revert: { past: "Rolled the files back", present: "Rolling the files back" },
  diff_since: { past: "Compared the changes", present: "Comparing the changes" },

  deploy_app: { past: "Deployed the app", present: "Deploying the app" },
  ask_user: { past: "Asked you a question", present: "Asking you a question" },
  request_write_action: { past: "Asked for permission", present: "Asking for permission" },
};

/** Keeps a long path readable without hiding which file it is. */
function shortenPath(value: string): string {
  const clean = value.replace(/^\.?\//, "");
  if (clean.length <= 48) return clean;
  const parts = clean.split("/");
  const name = parts[parts.length - 1] ?? clean;
  return name.length >= 44 ? `…${name.slice(-44)}` : `…/${name}`;
}

function describeArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || /\.\w{1,10}$/.test(trimmed)) return shortenPath(trimmed);
  return trimmed.length <= 48 ? `"${trimmed}"` : `"${trimmed.slice(0, 47)}…"`;
}

/**
 * A tool this module has no phrase for still gets readable words rather than a
 * raw identifier — a new tool should look unpolished, not broken.
 */
function fallback(tool: string): Phrase {
  const words = tool.replace(/_/g, " ");
  return { past: `Ran ${words}`, present: `Running ${words}` };
}

export function narrateTool(tool: string, args?: unknown): ToolNarration {
  const phrase = PHRASES[tool] ?? fallback(tool);
  const bag = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  let suffix = "";
  if (phrase.countArg) {
    const list = bag[phrase.countArg];
    const count = Array.isArray(list) ? list.length : 0;
    // A count of zero means the arguments were not on this event, not that the
    // model wrote nothing — so say nothing rather than "0 files".
    if (count > 0) suffix = ` ${count} ${phrase.countNoun}${count === 1 ? "" : "s"}`;
  } else if (phrase.arg) {
    const described = describeArg(bag[phrase.arg]);
    if (described) suffix = ` ${described}`;
  }

  return { label: `${phrase.past}${suffix}`, active: `${phrase.present}${suffix}` };
}

/** "+12 −3" for an edit row. Uses a real minus sign, not a hyphen. */
export function formatLineDelta(added: number, removed: number): string | undefined {
  if (added <= 0 && removed <= 0) return undefined;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return parts.join(" ");
}
