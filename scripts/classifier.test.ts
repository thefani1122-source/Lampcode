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

import { classifyBuild, hasPositiveDatabaseRequirement, hasPositiveMongoRequirement } from "../src/agents/build-classifier.js";
import { inferPromptBuildType, loadRelevantSkillsForPrompt } from "../src/agents/prompt-builder.js";
import { EVAL_TASKS } from "./eval/tasks.js";

let failures = 0;
function expectValue(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

async function expectType(
  name: string,
  prompt: string,
  want: "frontend" | "fullstack",
  wantAuth?: boolean,
  wantDatabase?: "supabase" | "mongodb" | "none",
): Promise<void> {
  const c = await classifyBuild(prompt);
  const okType = c.buildType === want;
  const okAuth = wantAuth === undefined || c.needsAuth === wantAuth;
  const okDatabase = wantDatabase === undefined || c.database === wantDatabase;
  if (okType && okAuth && okDatabase) {
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

// Regression from the 2026-11-12 TaskFlow build: a provider named only inside
// an explicit exclusion must not override browser-local architecture.
await expectType(
  "TaskFlow's localStorage build stays frontend when Supabase, external APIs and MCP are excluded",
  "Build TaskFlow, a personal task manager. Persist task data using browser localStorage " +
  "so it works without Supabase, external APIs, or MCP integrations. " +
  "Do not create fake backend integrations.",
  "frontend",
  false,
  "none",
);
await expectType(
  "a list of excluded providers does not become a backend request",
  "Build a single-user notes app with localStorage. Do not use Supabase, Firebase, or MongoDB.",
  "frontend",
  false,
  "none",
);
await expectType(
  "an explicitly rejected database does not replace the requested Supabase provider",
  "Build a full-stack notes app that saves notes in Supabase. Do not use MongoDB.",
  "fullstack",
  false,
  "supabase",
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

// ── Architecture-aware skill selection ───────────────────────────────────────
// A correct classifier decision is not enough if the prompt builder injects
// vendor instructions from words that appear only in a user exclusion.
const taskFlowPrompt =
  "Build TaskFlow, a personal task manager. Persist task data using browser localStorage " +
  "so it works without Supabase, external APIs, or MCP integrations. " +
  "Do not create fake backend integrations.";

expectValue(
  "TaskFlow's excluded Supabase mention is not a positive database request",
  hasPositiveDatabaseRequirement(taskFlowPrompt),
  false,
);

const frontendSkills = await loadRelevantSkillsForPrompt(taskFlowPrompt, "frontend");
expectValue(
  "frontend localStorage builds do not receive Supabase database rules",
  frontendSkills.includes("## Skill: database-rls"),
  false,
);
expectValue(
  "frontend localStorage builds do not receive Supabase RLS rules",
  frontendSkills.includes("## Skill: supabase-rls"),
  false,
);
expectValue(
  "frontend localStorage builds still receive frontend sandbox guidance",
  frontendSkills.includes("## Skill: frontend-sandbox"),
  true,
);

const backendWithoutDatabase = "Build a Hono API for webhook delivery. Do not use Supabase or a database.";
const backendSkills = await loadRelevantSkillsForPrompt(backendWithoutDatabase, "fullstack");
expectValue(
  "a backend without a database does not receive Supabase RLS instructions",
  backendSkills.includes("## Skill: supabase-rls"),
  false,
);

const supabaseSkills = await loadRelevantSkillsForPrompt("Build a full-stack app that stores user data in Supabase and authenticates each user.", "fullstack");
expectValue(
  "a Supabase full-stack app still receives its database RLS skill",
  supabaseSkills.includes("## Skill: database-rls"),
  true,
);
expectValue(
  "a Supabase full-stack app still receives its provider-specific RLS skill",
  supabaseSkills.includes("## Skill: supabase-rls"),
  true,
);

const mongoSkills = await loadRelevantSkillsForPrompt("Build an API backed by MongoDB.", "fullstack-mongodb");
expectValue(
  "MongoDB builds do not receive Supabase database rules",
  mongoSkills.includes("## Skill: database-rls"),
  false,
);
expectValue(
  "MongoDB builds do not receive Supabase RLS rules",
  mongoSkills.includes("## Skill: supabase-rls"),
  false,
);

const existingSkills = await loadRelevantSkillsForPrompt("Extend the existing PostgreSQL-backed app and preserve its current database provider.", "fullstack-existing");
expectValue(
  "existing full-stack edits preserve their own provider-specific instructions",
  existingSkills.includes("## Skill: supabase-rls"),
  false,
);

expectValue(
  "a negative MongoDB mention does not switch a full-stack task to MongoDB",
  inferPromptBuildType("frontend", "FULLSTACK BUILD: Build a Hono API. Do not use MongoDB; use Supabase."),
  "fullstack",
);
expectValue(
  "a positive MongoDB request still selects the MongoDB provider",
  inferPromptBuildType("frontend", "FULLSTACK BUILD: Build a MongoDB-backed API."),
  "fullstack-mongodb",
);
expectValue(
  "an explicit MongoDB URI still selects MongoDB",
  hasPositiveMongoRequirement("FULLSTACK BUILD: Use MONGODB_URI for persistence."),
  true,
);
expectValue(
  "Mongoose remains a supported positive MongoDB signal",
  hasPositiveMongoRequirement("FULLSTACK BUILD: Use mongoose models."),
  true,
);
expectValue(
  "a negative MongoDB provider mention does not select MongoDB",
  hasPositiveMongoRequirement("FULLSTACK BUILD: Use Supabase. Do not use MongoDB or mongoose."),
  false,
);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
