/**
 * Cases for importedPackages. Run by `npm test`.
 *
 * On 2026-10-04 three real builds imported react-router-dom — which the prompt
 * now asks for on any multi-view app — and none of them emitted a package.json
 * to declare it. Reading the declaration was the only install path, so nothing
 * was installed, Vite failed with "Failed to resolve import", and the preview
 * never came up. The app was dead on arrival in all three.
 *
 * This function replaces the declaration as the source of truth: what the code
 * IMPORTS is what the code needs. It now runs on every build, so a mistake here
 * is either a missing install (a broken preview again) or a junk package name
 * sent to npm.
 */

import { importedPackages } from "../src/preview/e2b-service.js";
import { findBrokenImports, formatBrokenImports } from "../src/verify/import-graph.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

/** For assertions that are already a boolean. */
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}
const sorted = (files: Record<string, string>) => importedPackages(files).sort();

// ── The case that caused this ─────────────────────────────────────────────────

check(
  "the import that broke three builds is found",
  sorted({
    "src/App.tsx": `import { BrowserRouter, Routes, Route, Link } from "react-router-dom";\nexport default function App() { return null }`,
  }),
  ["react-router-dom"],
);

// ── What is NOT a package ─────────────────────────────────────────────────────

check(
  "relative, alias and builtin specifiers are not packages",
  sorted({
    "src/App.tsx": [
      `import A from "./A";`,
      `import B from "../b/B";`,
      `import { cn } from "@/lib/utils";`,
      `import { readFile } from "node:fs/promises";`,
      `import C from "/abs/C";`,
    ].join("\n"),
  }),
  [],
);

// ── Name extraction ───────────────────────────────────────────────────────────

check(
  "a deep import resolves to its package",
  sorted({ "src/main.tsx": `import { createRoot } from "react-dom/client";` }),
  ["react-dom"],
);
check(
  "a scoped package keeps both segments",
  sorted({ "src/x.tsx": `import { Canvas } from "@react-three/fiber";` }),
  ["@react-three/fiber"],
);
check(
  "a scoped deep import still resolves to the package",
  sorted({ "src/x.ts": `import { something } from "@tanstack/react-query/build/modern";` }),
  ["@tanstack/react-query"],
);

// ── Import forms ──────────────────────────────────────────────────────────────

check(
  "side-effect, dynamic, require and re-export forms are all seen",
  sorted({
    "src/a.ts": `const m = await import("lodash-es");`,
    "src/b.ts": `const x = require("dayjs");`,
    "src/c.ts": `export { default as Chart } from "recharts";`,
    "src/d.tsx": `import type { Foo } from "zod";`,
  }),
  ["dayjs", "lodash-es", "recharts", "zod"],
);

// A bare side-effect import has no `from`, so it is deliberately NOT matched —
// missing one is a broken style import at worst, while loosening the pattern to
// catch it would start matching prose and comments.
check(
  "duplicates across files collapse to one",
  sorted({
    "src/a.tsx": `import { a } from "framer-motion";`,
    "src/b.tsx": `import { b } from "framer-motion";`,
  }),
  ["framer-motion"],
);

// ── Only real source files ────────────────────────────────────────────────────

check(
  "non-source files are ignored",
  sorted({
    "README.md": `install it with: import x from "not-a-real-package"`,
    "db/schema.sql": `-- import { a } from "also-not-real";`,
    "src/styles.css": `@import "tailwindcss";`,
  }),
  [],
);
check(
  "test files count — their imports need installing too",
  sorted({ "src/lib/x.test.ts": `import { describe, it } from "vitest";` }),
  ["vitest"],
);

// ── Nothing unusable reaches npm ──────────────────────────────────────────────
// Everything returned is passed to `npm install`, so a specifier that is not a
// valid registry name must be dropped here rather than shelled out.

check(
  "a url specifier is not treated as a package",
  sorted({ "src/a.ts": `import x from "https://esm.sh/canvas-confetti";` }),
  [],
);
check(
  "an uppercase or otherwise invalid name is dropped",
  sorted({ "src/a.ts": `import x from "Some_Invalid/NAME";` }),
  [],
);
check("no files means no packages", sorted({}), []);
check("an empty file means no packages", sorted({ "src/a.tsx": "" }), []);


// ── imports that point at nothing ────────────────────────────────────────────
// Session dc1fbc17, 2026-10-18. The model rewrote src/App.tsx to import
// ./pages/HomePage, ./pages/HabitsPage and ./pages/StatsPage and never wrote
// them. The person saw Vite's red overlay and, beside it, "I've built a
// complete habit tracker app".
//
// Nothing downstream was broken — the page sweep had passed BEFORE the
// rewrite, and the completion audit caught it honestly at the end, after the
// build was already reported complete. Both were right and both were late.

check(
  "the dc1fbc17 failure, exactly",
  findBrokenImports({
    "src/App.tsx": `import { HomePage } from "./pages/HomePage";\nimport { HabitsPage } from "./pages/HabitsPage";`,
  }).map((b) => b.specifier),
  ["./pages/HomePage", "./pages/HabitsPage"],
);

check(
  "an import that resolves is not reported",
  findBrokenImports({
    "src/App.tsx": `import { HomePage } from "./pages/HomePage";`,
    "src/pages/HomePage.tsx": "export const HomePage = () => null;",
  }),
  [],
);

check("the @/ alias resolves", findBrokenImports({
  "src/App.tsx": `import { Button } from "@/components/ui/button";`,
  "src/components/ui/button.tsx": "export const Button = () => null;",
}), []);

check("an index file resolves", findBrokenImports({
  "src/App.tsx": `import { x } from "./lib";`,
  "src/lib/index.ts": "export const x = 1;",
}), []);

// A bare package is a different problem with a different fix, and not this
// function's business.
check("a bare package is never reported", findBrokenImports({ "src/App.tsx": `import React from "react";` }), []);

// THE false positive that matters. src/styles.css and the rest of BAKED_FILES
// belong to the template and are deliberately absent from a build's file map,
// so flagging asset imports would report every generated app as broken. This
// was the single finding over 98 hand-written files before it was excluded.
check("a template-owned stylesheet is not reported", findBrokenImports({
  "src/main.tsx": `import "./styles.css";`,
}), []);
check("a Vite query suffix is not a path", findBrokenImports({
  "src/root.tsx": `import css from "../styles.css?url";`,
}), []);
check("an image import is not reported", findBrokenImports({
  "src/App.tsx": `import logo from "./assets/logo.svg";`,
}), []);

check(
  "the same missing import twice is reported once",
  findBrokenImports({
    "src/App.tsx": `import { A } from "./missing";\nimport { B } from "./missing";`,
  }).length,
  1,
);

check("an empty project reports nothing", findBrokenImports({}), []);

ok(
  "the message says what to do, not just what is wrong",
  /written or the import is removed/.test(
    formatBrokenImports([{ path: "src/App.tsx", specifier: "./pages/HomePage" }]),
  ),
);
check("nothing broken formats to nothing", formatBrokenImports([]), "");

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
