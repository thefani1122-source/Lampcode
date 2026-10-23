/**
 * Cases for the build lifecycle. Run by `npm test`.
 *
 * THE PRODUCTION FAILURE, a real build on 2026-10-18 (ShopHub). The user was
 * told, in order:
 *
 *     "Maine aapke liye … build kar di hai"
 *     "App ab chal raha hai!"
 *     Wiring in 31 component(s) that aren't used anywhere…
 *     2 control(s) render but don't do anything yet…
 *     Removing 21 leftover(s) from earlier edits…
 *
 * The success message came FIRST and three mutating repair steps came after it.
 * The cause was structural, not a misplaced line: the whole preview phase was
 * fire-and-forget (`void …then()`, `setImmediate`), and `finishPreview` said so
 * in its own first comment — "Everything in here runs AFTER the build session
 * has been recorded success." The frontend latches the first `build:complete`
 * it receives, so that one was final.
 *
 * These cases are structural too, because the thing to protect is an ORDER
 * inside one 4,000-line function: nothing that can change the delivered code
 * may run after the user has been told the build is done. They read the source
 * and compare positions — crude, but it fails loudly if someone moves the
 * completion emit back up, and that is exactly the regression to catch.
 */

import { readFileSync } from "node:fs";

const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

/** Position of a marker, asserted to exist exactly once. */
function at(needle: string): number {
  const first = build.indexOf(needle);
  if (first === -1) throw new Error(`FAIL marker missing: ${needle}`);
  if (build.indexOf(needle, first + 1) !== -1) throw new Error(`FAIL marker is not unique: ${needle}`);
  return first;
}

// ── The boundary exists at all ──────────────────────────────────────────────

check("the post-generation phase is a promise, not fire-and-forget", build.includes("let previewWork: Promise<void> = Promise.resolve();"));
check("it is awaited", build.includes("await withTimeout(previewWork, POST_BUILD_WAIT_MS"));
check("the setImmediate that used to detach it is gone", !build.includes("setImmediate(() => {\n          console.log(`[E2B] setImmediate fired"));
check("neither branch drops the chain on the floor", !build.includes("void writeFilesToSandbox(projectId, allFiles"));

// ── Order: every mutating step precedes the user being told ─────────────────

const completeEmit = at("server?.buildComplete(sessionId, {\n      sessionId,\n      files: frontendFiles,");
const awaitChain = at("await withTimeout(previewWork, POST_BUILD_WAIT_MS");
const freshness = at("const staleBefore = projectOutcome([");
const audit = at("── Completion audit, pass 2 of 2");
const architecture = at("const architectureFindings = findArchitectureGaps(allFiles);");
const dbSuccess = at('        status: "success",');
const terminalEvent = at('      type: "build/end",');

check("the repair chain is awaited before the completion audit", awaitChain < audit);
check("stale gates are re-run before the audit", freshness < audit);
check("the architecture gate reads the final files, after the chain", awaitChain < architecture);
check("the authoritative DB success is written after the audit", audit < dbSuccess);
check("the terminal event is recorded before the record is written", terminalEvent < dbSuccess);
check("the user is told last of all", dbSuccess < completeEmit);
check("and after the freshness re-runs", freshness < completeEmit);

// Every repair loop that mutates allFiles must sit before that boundary.
for (const [label, marker] of [
  ["fake-removal", "── Take the fake out before anyone sees it"],
  ["wiring", "── Wire up what renders but does nothing"],
  ["broken-imports", "── Imports that point at nothing"],
  ["dead-code-cut", "── Cut what the edits left behind"],
] as const) {
  check(`${label} repair runs before completion is emitted`, at(marker) < completeEmit);
}

// The three loops inside the chain are the ones that used to run after the
// record. They are still inside it — which is now before the boundary.
for (const kind of ["backend-start", "type-check", "browser-render"]) {
  const marker = `recorder.record({ type: "repair/applied", kind: "${kind}" });`;
  check(`the ${kind} repair is inside the awaited chain`, at(marker) < awaitChain);
}

// ── Freshness: re-run, or say it is unverified. Never upgrade to pass ──────

check("the re-run only happens with a live sandbox", build.includes("if (hasSandbox(projectId)) {"));
check("a gate that could not be re-run is listed as still stale", build.includes("stillStale.push("));
check("and that reaches the record", build.includes("unverifiedGates: stillStale"));
check("and the user is told in plain words", build.includes("treat them as unverified"));
check("a re-run emits a real verdict through the event stream", build.includes('recorder.record({ type: "verification/result", gate: "types"'));
check("tests keep their own \"none\" verdict instead of becoming a pass", build.includes('tests.outcome === "none" ? "none"'));
check("freshness is logged either way", build.includes("[build] freshness session="));

// ── The outcome is projected, and says which half is which ────────────────

check("the core outcome comes from the fold", build.includes("const projected = projectOutcome(recorder.events());"));
check("the projection is spread over the draft, not under it", build.indexOf("...projected,") > build.indexOf("...outcomeDraft,"));
check(
  "the final observations are labelled as observations, not event-derived",
  build.includes("THE SECOND HALF IS NOT EVENT-DERIVED AND IS NOT PRESENTED AS IF IT WERE"),
);
check("a short stream is recorded rather than smoothed over", build.includes("eventsLost: recorder.lostCount()"));
check("a failed build still gets its terminal event", build.includes('type: "build/failed",'));
check("events are flushed at boundaries, not only in the catch", (build.match(/await recorder\.flush\(\)/g) ?? []).length >= 4);

// ── Fullstack honesty ─────────────────────────────────────────────────────

check("the closing status is built from evidence", build.includes("const fullstackEvidence = fullstackRequested"));
check(
  "'real' requires backend, a connected database, queries, no faking — and tables",
  build.includes("fs.backendFiles > 0 &&") &&
    build.includes("fs.databaseConnected &&") &&
    build.includes("fs.tablesQueried > 0 &&") &&
    build.includes("fs.fakePersistenceFiles === 0 &&") &&
    // A connected database with no tables in it is not a working one.
    build.includes("fs.schemaApply?.ok !== false"),
);
check("a missing database is said in plain words", build.includes("Database: not connected, so nothing is saved on a server"));
check("a mocked sign-in is not called real", build.includes("Sign-in: not real yet"));
check("demo-data fallbacks are named", build.includes("fall back to demo data when the backend is missing"));
check("the evidence reaches the record too", build.includes("fullstack: fullstackEvidence"));
check("auth is only claimed real when it was asked for and found", build.includes("authReal: authWanted ? authReal : false"));
check("a file the fake detector flagged cannot prove auth", build.includes("!fakeFiles.includes(path) &&"));

// ── An overrun is reported, not swallowed ─────────────────────────────────

check("an overrun is recorded", build.includes('kind: "post-generation-phase-overran"'));
check("and told to the user", build.includes("The preview checks ran out of time"));


// ── What the real build exposed, 2026-10-19 ─────────────────────────────────
// The launch-proof build asked for sign-in and for claims that "persist in the
// database". It got four hardcoded users and localStorage, and the closing
// message said "now complete and fully functional". Two defects, both here:

check(
  "the honest status fires on what was ASKED, not only on what was built",
  build.includes("|| needsAuth(prompt);") && build.includes("the case that most needs an honest"),
);
check(
  "browser-only persistence is measured from the delivered code",
  build.includes("const writesBrowserStorage = Object.entries(allFiles).some(") &&
    build.includes("browserOnlyPersistence: writesBrowserStorage && backendFileCount === 0"),
);
check(
  "and the user is told their data lives in one browser",
  build.includes("Your data is saved in this browser only"),
);

// Every repair loop that mutates allFiles must emit files/written, or its
// writes invalidate a gate verdict silently. On the real build the
// broken-import loop rewrote files after check_page and check_types had passed
// and the record still read staleCheckPage=0.
check(
  "every pre-preview repair loop records its writes",
  (build.match(/recorder\.record\(\{ type: "files\/written"/g) ?? []).length >= 7,
);
for (const [label, marker] of [
  ["fake-removal", "paths: rewritten,"],
  ["wiring", "paths: wired,"],
  ["broken-imports", "paths: created,"],
  ["dead-code-cut", "paths: cutPaths,"],
] as const) {
  check(`${label} says which files it changed`, build.includes(marker));
}
check(
  "and the measurement that forced it is written down",
  build.includes("the record still said staleCheckPage=0"),
);

// ── The preview URL has to SURVIVE, not just be announced ───────────────────
// Measured 2026-10-23 on the first real build after the AWS move: the agent's
// own closing message carried "The app is running at https://5173-….e2b.app"
// while the preview pane said "Build finished, but no preview URL was
// returned". The sandbox was up and serving the whole time.
//
// The cause was structural, not a race. `build_sessions.preview_url` existed
// as a column and was only ever written as null, so the socket event was the
// ONLY delivery the URL ever had — and the fallback the frontend polls every
// 3s, /api/build/:id/files, did not return a preview URL either. Missing one
// websocket event therefore lost the preview permanently, and the message
// shown to the user was guaranteed rather than diagnostic.

check(
  "the preview URL is persisted where the poll can find it",
  /emitPreviewUrl\(sessionId[\s\S]{0,1400}db\.update\(buildSessions\)\.set\(\{ previewUrl: url \}\)/.test(build),
);
check(
  "and failing to persist it never fails the build",
  build.includes("the socket event is now its only delivery"),
);
check(
  "the files endpoint returns it, which is what the frontend polls for",
  /return c\.json\(\{[\s\S]{0,600}previewUrl: session\.previewUrl/.test(build),
);
// The bug in one line: every write to this column set it to null.
check(
  "the column is no longer only ever set to null",
  (build.match(/previewUrl: null/g) ?? []).length > 0 && build.includes("previewUrl: url"),
);

console.log(`\n${checks} lifecycle checks passed`);
