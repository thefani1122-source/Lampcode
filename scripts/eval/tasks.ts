/**
 * The fixed evaluation set.
 *
 * Twenty prompts that do not change between runs. That is the whole point: until
 * now every prompt change, every harness change and every model switch was
 * judged on one build somebody happened to watch, which is why the styling bug
 * survived three months and `check_page` could be structurally broken for three
 * weeks without anyone noticing.
 *
 * Writing a task:
 *  - `prompt` is sent verbatim. Never edit an existing one — a changed prompt
 *    makes every stored run incomparable. Add a new task instead and retire the
 *    old one with `retired: true`.
 *  - `mustContain` / `mustNotContain` run against the concatenated content of
 *    every generated file. Keep them to things any correct implementation of
 *    the prompt has to contain, not one particular way of writing it. A check
 *    that a good build can fail is worse than no check.
 *  - `minFiles` is the component-splitting signal. The agent's standing habit is
 *    to put a whole four-view app in `App.tsx`; a build that works but ships one
 *    2000-line file is a build whose next edit rewrites everything.
 *  - `maxLinesPerFile` catches the same thing from the other side.
 *
 * Tiers exist so a cheap smoke run is possible without the full set — a full
 * sweep is twenty real builds and real money.
 */

export type EvalTask = {
  id: string;
  title: string;
  /** "smoke" = 4 cheap tasks, "core" = the main set, "hard" = long/complex. */
  tier: "smoke" | "core" | "hard";
  prompt: string;
  /** Substrings or regexes every correct build must produce somewhere. */
  mustContain?: Array<string | RegExp>;
  /** Things that mean the build went wrong (template-owned files, stubs). */
  mustNotContain?: Array<string | RegExp>;
  /** Minimum number of generated files — the component-splitting check. */
  minFiles?: number;
  /** Fail a build whose largest single file exceeds this. */
  maxLinesPerFile?: number;
  /** Minimum number of `*.test.ts(x)` files. Set this only where the task has
   *  logic whose correctness is not visible by reading it — a formula
   *  evaluator, a running total — since that is the only case the build prompt
   *  asks for tests. Asking for tests on a layout task would penalise a build
   *  for something it was never told to do. */
  minTestFiles?: number;
  /** Set instead of deleting a task, so old results stay readable. */
  retired?: boolean;
};

export const EVAL_TASKS: EvalTask[] = [
  // ── smoke: cheap, unambiguous, run these when you just need a pulse ───────
  {
    id: "counter",
    title: "Counter with persistence",
    tier: "smoke",
    prompt:
      "Build a counter app. One number, an increment and a decrement button, and a reset. " +
      "The count survives a page reload. Center it on the page with large type.",
    mustContain: ["localStorage"],
  },
  {
    id: "todo",
    title: "Todo list",
    tier: "smoke",
    prompt:
      "Build a todo list. Add a task, mark it done, delete it, and filter by all / active / " +
      "done. Tasks persist across reloads. Show an empty state when there are no tasks.",
    mustContain: ["localStorage", /filter/i],
    minFiles: 2,
  },
  {
    id: "pricing-page",
    title: "Pricing page",
    tier: "smoke",
    prompt:
      "Build a pricing page for a SaaS product with three tiers (Free, Pro, Team), a " +
      "monthly/yearly toggle that actually changes the displayed prices, a feature " +
      "comparison list, and an FAQ section. Responsive down to 390px.",
    minFiles: 2,
  },
  {
    id: "form-validation",
    title: "Multi-step form with validation",
    tier: "smoke",
    prompt:
      "Build a three-step signup form: account details, profile, confirm. Validate each step " +
      "before allowing Next — email format, password at least 8 characters, required fields — " +
      "and show the error under the field it belongs to. Back preserves what was typed. " +
      "The final step shows a summary of everything entered.",
    mustContain: [/invalid|error|required/i],
    minFiles: 2,
  },

  // ── core ──────────────────────────────────────────────────────────────────
  {
    id: "kanban",
    title: "Drag-and-drop kanban",
    tier: "core",
    prompt:
      "Build a kanban board with four columns (Backlog, In Progress, Review, Done). Cards can " +
      "be dragged between columns and reordered within one. A card has a title, description, " +
      "assignee and priority. Add and delete cards. State persists across reloads.",
    mustContain: ["localStorage", /drag|dnd|onDrop/i],
    minFiles: 3,
  },
  {
    id: "dashboard",
    title: "Analytics dashboard",
    tier: "core",
    prompt:
      "Build an analytics dashboard: four KPI cards with trend indicators, a line chart of " +
      "revenue over twelve months, a bar chart of signups by channel, and a table of the ten " +
      "most recent orders with sortable columns. Use realistic mock data. Dark mode toggle " +
      "that persists.",
    mustContain: [/recharts|chart/i],
    minFiles: 4,
  },
  {
    id: "data-table",
    title: "Sortable, filterable, paginated table",
    tier: "core",
    prompt:
      "Build a table of 200 mock employees with search, column sorting, filtering by " +
      "department, and pagination at 25 rows per page. Selecting rows shows a bulk-action bar. " +
      "Clicking a row opens a detail panel that closes on Escape.",
    mustContain: [/Escape/],
    minFiles: 3,
  },
  {
    id: "calendar",
    title: "Month calendar with events",
    tier: "core",
    prompt:
      "Build a month-view calendar. Navigate between months, click a day to add an event with " +
      "a title and time, click an event to edit or delete it. Today is highlighted. Events " +
      "persist across reloads. Days with events show a count.",
    mustContain: ["localStorage"],
    minFiles: 3,
  },
  {
    id: "chat-ui",
    title: "Chat interface",
    tier: "core",
    prompt:
      "Build a chat interface: a conversation list on the left, messages on the right, a " +
      "composer that sends on Enter and newlines on Shift+Enter. Show a typing indicator and " +
      "fake a reply after a short delay. Messages scroll to the bottom on send. Works at " +
      "390px, where the conversation list collapses.",
    mustContain: [/Enter/],
    minFiles: 3,
  },
  {
    id: "file-explorer",
    title: "Recursive file tree",
    tier: "core",
    prompt:
      "Build a file explorer for a mock project tree: folders expand and collapse, files show " +
      "an icon by extension, and selecting a file shows its contents in a pane on the right. " +
      "Include a search box that filters the tree and keeps matching parents visible.",
    minFiles: 3,
  },
  {
    id: "settings-tabs",
    title: "Settings with dirty-state guard",
    tier: "core",
    prompt:
      "Build a settings page with four tabs: Profile, Notifications, Billing, Danger Zone. " +
      "Changes are only applied on Save, Cancel reverts them, and switching tabs with unsaved " +
      "changes warns first. Danger Zone's delete requires typing the account name to confirm.",
    mustContain: [/unsaved|dirty/i],
    minFiles: 4,
  },
  {
    id: "wizard-state",
    title: "Checkout flow",
    tier: "core",
    prompt:
      "Build a checkout flow: cart with quantity controls and a running total, shipping " +
      "address form, payment details (no real processing), review, and a confirmation screen " +
      "with an order number. The total updates with quantity and a shipping method choice. " +
      "Going back never loses entered data.",
    minFiles: 4,
  },
  {
    id: "search-filter",
    title: "Product catalog",
    tier: "core",
    prompt:
      "Build a product catalog of 60 mock items: a grid of cards, filters for category, price " +
      "range and rating, sort by price or rating, and a search box. Filters combine. Show a " +
      "result count and an empty state when nothing matches. Filter state survives reload.",
    minFiles: 4,
  },
  {
    id: "theme-system",
    title: "Theming with a design system",
    tier: "core",
    prompt:
      "Build a component gallery page that demonstrates buttons (four variants, three sizes, " +
      "loading and disabled states), inputs with labels and errors, badges, cards, a modal and " +
      "a toast. Every component is a separate file under src/components. A light/dark toggle " +
      "switches all of them.",
    minFiles: 6,
    maxLinesPerFile: 400,
  },
  {
    id: "python-api",
    title: "Python backend",
    tier: "core",
    prompt:
      "Build a FastAPI backend with a React frontend: a notes API with create, list, update " +
      "and delete, held in memory, and a frontend that uses it. The frontend shows a loading " +
      "state while fetching and an error state if a request fails.",
    mustContain: [/fastapi/i, /uvicorn|APIRouter|FastAPI\(/],
    minFiles: 3,
  },

  // ── hard: the long/complex builds that are the actual product claim ───────
  {
    id: "crm",
    title: "Four-view CRM",
    tier: "hard",
    prompt:
      "Build a CRM with four views behind a sidebar: a dashboard with KPI cards and a revenue " +
      "chart, a searchable client table whose rows open a detail panel, a drag-and-drop " +
      "pipeline of deals by stage, and settings. All data persists in localStorage with " +
      "validation on every form, empty states everywhere, Escape closes any panel, and the " +
      "whole thing works down to 390px.",
    mustContain: ["localStorage", /Escape/],
    minFiles: 6,
    maxLinesPerFile: 500,
  },
  {
    id: "project-tracker",
    title: "Project tracker with time tracking",
    tier: "hard",
    prompt:
      "Build a project tracker: projects contain tasks, tasks have estimates and logged time, " +
      "and a timer can run on one task at a time and keeps counting while you navigate. Views " +
      "for board, list and a per-project report of estimated versus actual. Everything " +
      "persists, including a timer that was running when the page was closed.",
    mustContain: ["localStorage"],
    minFiles: 6,
    maxLinesPerFile: 500,
  },
  {
    id: "form-builder",
    title: "Drag-and-drop form builder",
    tier: "hard",
    prompt:
      "Build a form builder: drag field types (text, number, select, checkbox, date, textarea) " +
      "from a palette onto a canvas, reorder them, edit each field's label, placeholder, " +
      "required flag and options in a properties panel, then preview the built form and " +
      "validate it on submit. The built form's definition persists and can be exported as JSON.",
    mustContain: [/JSON.stringify/],
    minFiles: 6,
    maxLinesPerFile: 500,
  },
  {
    id: "spreadsheet",
    title: "Spreadsheet with formulas",
    tier: "hard",
    prompt:
      "Build a spreadsheet: a 20x10 grid, click a cell to edit, arrow keys move the selection, " +
      "and a cell starting with = evaluates a formula supporting cell references, + - * / and " +
      "SUM over a range. A formula showing a circular reference reports an error instead of " +
      "hanging. Contents persist across reloads.",
    mustContain: ["localStorage", /SUM/],
    minFiles: 4,
    maxLinesPerFile: 500,
    // The clearest case in the set for a test: formula evaluation with a
    // circular-reference rule is logic that can render perfectly and still be
    // wrong, which is exactly what check_page and check_types cannot see.
    minTestFiles: 1,
  },
  {
    id: "editor-undo",
    title: "Editor with undo history",
    tier: "hard",
    prompt:
      "Build a note editor with a sidebar of notes, markdown preview beside the editor, and " +
      "undo/redo with Cmd+Z and Cmd+Shift+Z that is per-note and survives switching notes. " +
      "Notes persist, are searchable by content, and show a word count and last-edited time.",
    mustContain: ["localStorage", /undo/i],
    minFiles: 5,
    maxLinesPerFile: 500,
  },
];

export function tasksFor(tiers: Array<EvalTask["tier"]>, only?: string[]): EvalTask[] {
  return EVAL_TASKS.filter((t) => {
    if (t.retired) return false;
    if (only && only.length > 0) return only.includes(t.id);
    return tiers.includes(t.tier);
  });
}
