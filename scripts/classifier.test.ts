/**
 * Cases for classifyBuild. Run by `npm test`.
 *
 * This decides whether a build gets a Hono backend and a Supabase schema, from
 * the prompt alone. The 2026-10-03 eval measured what it was getting wrong:
 * half the smoke set asked for a browser-only app and got a database. With the
 * preview Supabase project paused, those apps ship and their writes fail.
 *
 * The cost is asymmetric in both directions, so both are pinned here:
 *  - false fullstack: an over-built app with storage that cannot work;
 *  - false frontend: someone asks for real auth and gets a UI with no backend.
 *
 * The real prompts from HISTORY.md (Atlas, ForgeFlow) and all twenty
 * eval prompts are included, so a future narrowing cannot quietly break the
 * cases that were already right.
 */

import { classifyBuild } from "../src/agents/build-classifier.js";
import { EVAL_TASKS } from "./eval/tasks.js";

let failures = 0;
async function expectType(
  name: string,
  prompt: string,
  want: "frontend" | "fullstack",
  wantAuth?: boolean,
): Promise<void> {
  const c = await classifyBuild(prompt);
  const okType = c.buildType === want;
  const okAuth = wantAuth === undefined || c.needsAuth === wantAuth;
  if (okType && okAuth) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(
    `✘ ${name}\n    got:  ${c.buildType}, auth=${c.needsAuth}, db=${c.database} (${c.reason})` +
    `\n    want: ${want}${wantAuth === undefined ? "" : `, auth=${wantAuth}`}`,
  );
}

// ── The two the eval caught ───────────────────────────────────────────────────

await expectType(
  "\"tasks persist across reloads\" is localStorage, not a database",
  "Build a todo list. Add a task, mark it done, delete it, and filter by all / active / done. " +
  "Tasks persist across reloads. Show an empty state when there are no tasks.",
  "frontend",
  false,
);
await expectType(
  "a three-step signup FORM is UI, not an auth system",
  "Build a three-step signup form: account details, profile, confirm. Validate each step " +
  "before allowing Next — email format, password at least 8 characters, required fields. " +
  "The final step shows a summary of everything entered.",
  "frontend",
  false,
);

// ── Genuine fullstack must still be detected ──────────────────────────────────

await expectType("an explicit database is fullstack", "Build a blog that saves posts to Supabase.", "fullstack");
await expectType("mongodb is fullstack", "A recipe app backed by MongoDB.", "fullstack");
await expectType("a named backend is fullstack", "Build a Hono API with a React frontend.", "fullstack");
await expectType("a REST API is fullstack", "Build a notes app with a REST API.", "fullstack");
await expectType("multi-user is fullstack", "A team chat where multiple users see the same messages.", "fullstack");
await expectType("payments are fullstack", "A store with Stripe checkout.", "fullstack");
await expectType("file uploads are fullstack", "A gallery with file uploads.", "fullstack");
await expectType("real-time is fullstack", "A real-time collaborative whiteboard.", "fullstack");
await expectType(
  "real authentication is fullstack and needs auth",
  "Build a dashboard where users log in with their email and password and only see their own data.",
  "fullstack",
  true,
);
await expectType(
  "oauth is real auth",
  "Users sign in with Google OAuth, then manage their saved items.",
  "fullstack",
  true,
);
await expectType("next.js still routes fullstack", "Build a Next.js marketing site.", "fullstack");

// ── A hard server signal beats a client-only marker ───────────────────────────

await expectType(
  "supabase plus localStorage caching is still fullstack",
  "Store the records in Supabase and cache them in localStorage for offline reads.",
  "fullstack",
);
await expectType(
  "an explicit no-backend instruction is honoured",
  "A kanban board with no backend — keep everything in localStorage.",
  "frontend",
  false,
);
// The negation bug these cases caught: "no backend" contains the word
// "backend", so an instruction NOT to build one read as an instruction to
// build one.
await expectType(
  "\"without a backend\" is honoured",
  "A notes app without a backend, everything in browser storage.",
  "frontend",
);
await expectType(
  "\"no database\" is honoured",
  "A budget tracker with no database — keep the numbers in localStorage.",
  "frontend",
);
await expectType(
  "\"doesn't need a server\" is honoured",
  "A unit converter that doesn't need a server.",
  "frontend",
);
// Negation-stripping must not swallow a real request sitting next to it.
await expectType(
  "a real backend request is untouched by the negation strip",
  "Build a backend with Hono that stores submissions.",
  "fullstack",
);

await expectType(
  "mock data means frontend",
  "An analytics dashboard with four KPI cards and a revenue chart using mock data.",
  "frontend",
);

// ── 3D and animation no longer imply a database ───────────────────────────────
// They used to force fullstack to route the build to E2B, where Three.js is
// pre-installed. build.ts now sends every build to E2B regardless, so all that
// remained was giving a landing page a Supabase schema.

await expectType("a three.js landing page is frontend", "A Three.js landing page with a rotating globe.", "frontend");
await expectType("webgl shaders are frontend", "An immersive WebGL shader background with scroll parallax.", "frontend");
await expectType("a spline scene is frontend", "A product page with a Spline 3D scene.", "frontend");
await expectType("gsap scroll animation is frontend", "A site with GSAP ScrollTrigger animations.", "frontend");
await expectType(
  "3D plus a real database is still fullstack",
  "A Three.js product configurator that saves each configuration to Supabase.",
  "fullstack",
);

// ── The historical prompts from HISTORY.md ────────────────────────────────────

await expectType(
  "Atlas (the 2026-10-01 build) is frontend",
  "Atlas, a 4-view client/project tracker: dashboard with KPI cards and a revenue chart, a " +
  "searchable client table with a detail panel, a drag-and-drop kanban, and settings. " +
  "localStorage persistence, validation, empty states, Escape-to-close, responsive to 390px.",
  "frontend",
  false,
);

// ── The whole eval set, as a regression net ───────────────────────────────────
// Not asserting a verdict for each — asserting that the ones meant to be
// browser-only are, since that is what the eval found broken.

const expectedFrontend = new Set([
  "counter", "todo", "pricing-page", "form-validation", "kanban", "dashboard",
  "data-table", "calendar", "file-explorer", "settings-tabs", "search-filter",
  "theme-system", "crm", "project-tracker", "form-builder", "spreadsheet", "editor-undo",
]);
for (const task of EVAL_TASKS) {
  if (!expectedFrontend.has(task.id)) continue;
  await expectType(`eval task "${task.id}" is frontend`, task.prompt, "frontend");
}
// And the ones that genuinely are fullstack.
for (const id of ["python-api"]) {
  const task = EVAL_TASKS.find((t) => t.id === id);
  if (task) await expectType(`eval task "${id}" is fullstack`, task.prompt, "fullstack");
}

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
