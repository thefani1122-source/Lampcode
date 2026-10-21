import { readFileSync } from "node:fs";
/**
 * The classification corpus. Run by `npm test`.
 *
 * THIS IS THE DECISION EVERYTHING ELSE DEPENDS ON. If a request that needs a
 * server is called "frontend", then: no backend file is written, the database
 * gate never asks the user to connect anything, the prompt carries no database
 * instructions, and the app ships with its data in one browser — while every
 * gate passes and the closing message says it is done. Nothing downstream can
 * recover from it, which is why it gets a corpus of its own rather than a
 * handful of cases.
 *
 * MEASURED 2026-10-19 on a real build, and the reason this file exists. The
 * prompt was "a person signs in … sees only their own claims … claims persist
 * in the database". It was classified frontend. Probing the old classifier
 * afterwards, EIGHT of nine backend-shaped prompts came back frontend: "signs
 * in" and "logs in" both missed (only the literal "sign in" matched), "each
 * customer has their own account" missed, and a bare "database" was not a
 * server signal at all.
 *
 * MEASURED 2026-10-21, fixing it: the first rewrite over-corrected and called a
 * PRICING PAGE fullstack, because its tiers are named "Free, Pro, Team", and a
 * table of "200 mock employees" fullstack because of the word employees. Both
 * directions are in here now, deliberately, because a classifier is only as
 * good as the two mistakes it refuses to make.
 *
 * Every case below runs the DETERMINISTIC layer only — no model, no network, no
 * cost. The judgement layer is tested against the live model separately (see
 * HISTORY 2026-10-21: nine of nine sound), because a case that needs a paid API
 * call is a case nobody runs.
 */

import { classifyBuild, parseClassification, readSignals } from "../src/agents/build-classifier.js";
import { EVAL_TASKS } from "./eval/tasks.js";

let failures = 0;
let checks = 0;

function ok(name: string, condition: boolean): void {
  checks++;
  if (condition) {
    console.log(`✔ ${name}`);
  } else {
    failures++;
    console.error(`✘ ${name}`);
  }
}

async function wants(
  expected: "frontend" | "fullstack",
  label: string,
  prompt: string,
): Promise<void> {
  const c = await classifyBuild(prompt);
  checks++;
  if (c.buildType === expected) {
    console.log(`✔ ${expected.padEnd(9)} ${label}`);
  } else {
    failures++;
    console.error(`✘ ${expected.padEnd(9)} ${label} — got ${c.buildType} (${c.source}: ${c.reason})`);
  }
}

// ── Needs a server, and the deterministic layer must see it ─────────────────
// Each of these is a shape a real person types. The conjugations are the point:
// English does not restrict itself to the infinitive.

console.log("\n— must be fullstack —");
await wants("fullstack", "the 2026-10-19 build, verbatim",
  "Build a team expense tracker. A person signs in, submits an expense claim with an amount, " +
  "a category and a note, and sees only their own claims in a table they can filter by category. " +
  "A separate approvals page lists claims awaiting a decision with approve and reject buttons, " +
  "and nobody may approve their own claim. Claims persist in the database so they survive a reload.");
await wants("fullstack", "signs in (third person)", "An app where a person signs in and sees their profile.");
await wants("fullstack", "sign in (infinitive)", "An app where a person can sign in and see their profile.");
await wants("fullstack", "logs in", "An app where a user logs in and sees their orders.");
await wants("fullstack", "logged in", "Only a logged in user can post.");
await wants("fullstack", "signing up", "People signing up get a welcome screen and their own dashboard.");
await wants("fullstack", "user accounts", "A site with user accounts and saved preferences.");
await wants("fullstack", "create an account", "Visitors create an account before they can book.");
await wants("fullstack", "bare database", "A notes app where notes are stored in the database.");
await wants("fullstack", "save to a database", "Save the entries to a database.");
await wants("fullstack", "named Supabase", "A blog that keeps its posts in Supabase.");
await wants("fullstack", "named Mongo", "An app that stores readings in MongoDB.");
await wants("fullstack", "api routes", "A dashboard with REST API endpoints for the data.");
await wants("fullstack", "each user", "Each user has a profile page with their posts.");
await wants("fullstack", "their own", "Each customer has their own account and sees only their own invoices.");
await wants("fullstack", "only they", "A journal where only they can read their entries.");
await wants("fullstack", "team members", "Team members can assign tasks to each other.");
await wants("fullstack", "across devices", "A shopping list that is there on another device.");
await wants("fullstack", "real payments", "A store that accepts payments with Stripe.");
await wants("fullstack", "file uploads", "Users can do file uploads of their documents.");
await wants("fullstack", "roles", "An app with user roles: admin, editor, viewer.");
await wants("fullstack", "sends email", "A form that sends an email to the team when submitted.");
await wants("fullstack", "named Next.js", "A Next.js dashboard for orders.");
await wants("fullstack", "collaboration", "A document people can collaborate on at the same time.");

// ── The browser is enough, and the layer must not invent a server ───────────

console.log("\n— must be frontend —");
await wants("frontend", "landing page", "A landing page for a coffee shop with a hero and pricing.");
await wants("frontend", "explicit localStorage", "A todo app that persists across reloads in localStorage.");
await wants("frontend", "explicit no backend", "A calculator with no backend.");
await wants("frontend", "signup FORM (ui only)", "A three-step signup form that validates fields and shows a summary.");
await wants("frontend", "login PAGE (ui only)", "Design a login page with a dark theme.");
await wants("frontend", "pricing tier named Team", "A pricing page with three tiers: Free, Pro, Team, and a monthly/yearly toggle.");
await wants("frontend", "mock employees", "A table of 200 mock employees with search, sorting and pagination.");
await wants("frontend", "no real processing", "A checkout flow with payment details (no real processing) and a confirmation screen.");
await wants("frontend", "Billing TAB", "A settings page with four tabs: Profile, Notifications, Billing, Danger Zone.");
await wants("frontend", "sample data", "A chart dashboard built from sample data.");
await wants("frontend", "offline", "An offline pomodoro timer.");
await wants("frontend", "game", "A 2048 game with keyboard controls and a high score.");

// ── Negation must not read as its opposite ──────────────────────────────────
// "no backend" contains "backend". A bare match read an instruction NOT to
// build one as an instruction to build one.

console.log("\n— negation —");
await wants("frontend", "no database", "A unit converter with no database.");
await wants("frontend", "without a server", "A markdown preview tool without a server.");
await wants("frontend", "don't need accounts", "A public poll — I don't need accounts.");
await wants("fullstack", "named db wins over a cache mention",
  "Store the orders in Supabase and cache the last view in localStorage.");

// ── Signals, read one at a time ─────────────────────────────────────────────

console.log("\n— signals —");
ok("a conjugated sign-in is an auth system", readSignals("she signs in each morning").authSystem);
ok("a login FORM is not", !readSignals("a login form with validation").authSystem);
ok("'their own' is a multi-person signal", readSignals("each person sees their own rows").multiPerson);
ok("a 'Team' plan name is not", !readSignals("three tiers: Free, Pro, Team").multiPerson);
ok("'mock employees' is a not-real marker", readSignals("200 mock employees").notReal);
ok("'no real processing' is too", readSignals("payment details (no real processing)").notReal);
ok("a bare 'database' is a server thing", readSignals("kept in the database").namedServerThing);
ok("'no database' is not", !readSignals("a timer with no database").namedServerThing);
ok("'another device' is cross-device", readSignals("available on another device").crossDevice);
ok("mongo is detected for the db choice", readSignals("store it in MongoDB").mentionsMongo);

// ── The source is recorded honestly ─────────────────────────────────────────

console.log("\n— source —");
{
  const explicitServer = await classifyBuild("keep the rows in Postgres");
  ok("a named database is explicit-server", explicitServer.source === "explicit-server");
  const explicitClient = await classifyBuild("a todo list in localStorage");
  ok("a named browser store is explicit-client", explicitClient.source === "explicit-client");
  const leaned = await classifyBuild("a pomodoro timer with a sound at the end");
  ok("an ambiguous prompt with no model says it leaned", leaned.source === "lean-client");
  ok("and a lean never silently claims a database", leaned.database === "none");
  const auth = await classifyBuild("users log in and see their own files");
  ok("auth scaffolding follows the auth signal", auth.needsAuth === true);
  const noAuth = await classifyBuild("the readings are written to the database");
  ok("and is NOT invented for a database-only request", noAuth.needsAuth === false);
  ok("a frontend build never carries needsAuth", (await classifyBuild("a login page mockup")).needsAuth === false);
}

// ── The judgement pass's parser ─────────────────────────────────────────────

console.log("\n— parser —");
ok("reads a clean answer", parseClassification('{"needsServer":true,"needsSignIn":true,"why":"two people"}')?.needsServer === true);
ok("reads it out of prose and fences", parseClassification('Sure!\n```json\n{"needsServer":false,"needsSignIn":false,"why":"one user"}\n```')?.needsServer === false);
ok("a missing needsServer is unusable, NOT false", parseClassification('{"needsSignIn":true}') === null);
ok("a non-boolean needsServer is unusable", parseClassification('{"needsServer":"yes"}') === null);
ok("malformed JSON returns null", parseClassification("{needsServer:") === null);
ok("empty returns null", parseClassification("") === null);
ok("prose with no JSON returns null", parseClassification("I think it needs a server.") === null);
ok("why is clipped, never unbounded", (parseClassification(`{"needsServer":true,"why":"${"x".repeat(900)}"}`)?.why.length ?? 0) <= 200);

// ── The instruction asks the narrow question ─────────────────────────────────
// "Would a backend be nicer" has one answer for every app ever described. The
// question has to be whether the app is WRONG without one.

console.log("\n— instruction —");
{
  const { CLASSIFY_INSTRUCTION } = await import("../src/agents/build-classifier.js");
  ok("it asks about more than one person", /more than one person/i.test(CLASSIFY_INSTRUCTION));
  ok("it asks about another device", /different device/i.test(CLASSIFY_INSTRUCTION));
  ok("it forbids 'a server would be nicer'", /nicer|more scalable/i.test(CLASSIFY_INSTRUCTION));
  ok("it names browser-only examples", /notes app|calculator|landing page/i.test(CLASSIFY_INSTRUCTION));
  ok("it demands JSON only", /Return JSON only/.test(CLASSIFY_INSTRUCTION));
}

// ── The eval corpus must not move ───────────────────────────────────────────
// These twenty prompts have scored runs behind them. Exactly one of them —
// python-api — asks for a server. If this block ever reports a different
// number, every stored eval comparison has quietly changed meaning.

console.log("\n— the eval corpus —");
{
  const tasks = EVAL_TASKS as Array<{ id: string; prompt: string }>;
  const fullstack: string[] = [];
  for (const task of tasks) {
    const c = await classifyBuild(task.prompt);
    if (c.buildType === "fullstack") fullstack.push(task.id);
  }
  ok(`exactly one eval task needs a server (got: ${fullstack.join(",") || "none"})`, fullstack.length === 1 && fullstack[0] === "python-api");
  ok("all twenty were classified", tasks.length === 20);
}


// ── The model is the DEFAULT, the words are not ─────────────────────────────
// The old classifier was a word list making a judgement call it had no business
// making, and it read "a person signs in … claims persist in the database" as a
// browser app for months. The order now is: what the user NAMED (their own
// instruction), then the model (judgement), then the words (fallback only).

console.log("\n— the model decides, not the words —");
{
  const src = readFileSync(new URL("../src/agents/build-classifier.ts", import.meta.url), "utf8");
  const namedLayer = src.indexOf("// ── 1. The user TOLD us");
  const modelLayer = src.indexOf("// ── 2. Everything else: the model reads it");
  const wordsLayer = src.indexOf("// ── 3. No model: fall back to the words");
  ok("what the user named is answered first", namedLayer > 0 && namedLayer < modelLayer);
  ok("the model comes before the word signals", modelLayer > 0 && modelLayer < wordsLayer);
  ok("and the fallback says so in its comment", /FALLBACK/.test(src.slice(wordsLayer, wordsLayer + 700)));

  // The inferred signals must NOT short-circuit the model any more. Only the
  // two "the user named it" signals may.
  const beforeModel = src.slice(namedLayer, modelLayer);
  ok("an auth guess does not pre-empt the model", !beforeModel.includes("signals.authSystem)"));
  ok("a multi-person guess does not either", !beforeModel.includes("signals.multiPerson"));
  ok("a cross-device guess does not either", !beforeModel.includes("signals.crossDevice"));
}

{
  // With no dispatcher the words still have to be right, because that is what
  // runs when the model is unavailable — but the source must admit it.
  const leaned = await classifyBuild("a person signs in and sees their own claims");
  ok("the fallback still gets a sign-in right", leaned.buildType === "fullstack");
  ok("and marks it as a lean, not a reading", leaned.source === "lean-server");

  const named = await classifyBuild("keep the rows in Postgres");
  ok("a named database is still answered without a model", named.source === "explicit-server");
  const namedBrowser = await classifyBuild("a todo list in localStorage");
  ok("so is a named browser store", namedBrowser.source === "explicit-client");
}

console.log(`\n${checks} classification checks, ${failures} failed`);
if (failures > 0) process.exit(1);
