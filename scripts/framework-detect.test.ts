/**
 * Which framework an EXISTING project is, read from its own files.
 *
 * WHY THIS EXISTS — found 2026-11-28. A new build gets its framework from the
 * classifier, but every follow-up edit gets it from `detectFrameworkFromFiles`,
 * and the answer decides which contract the next prompt carries. React/Vite
 * serves its backend on a second origin and is given the
 * `API_BASE = import.meta.env.VITE_API_URL ?? ''` rule; Next.js is same-origin
 * and is deliberately not. Detect the wrong one and the edit is handed a rule
 * about an origin the app does not have — the exact bug `wiring.ts` carries a
 * `hardcoded-dev-host` check for.
 *
 * The test was `app/layout.tsx || next.config.js`, and the second half was
 * DEAD: e2b-template/template-nextjs-ubuntu.ts writes `next.config.ts`. One
 * missing app/layout.tsx was all it took to fall through to "react".
 */
import { detectFrameworkFromFiles } from "../src/agents/framework-selection.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (got === want) { console.log(`✔ ${name}`); return; }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
const f = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, ""]));

// ── the config file the template actually writes ───────────────────────────
check("next.config.ts is recognised", detectFrameworkFromFiles(f("next.config.ts")), "nextjs");
check("next.config.js still is", detectFrameworkFromFiles(f("next.config.js")), "nextjs");
check("next.config.mjs too", detectFrameworkFromFiles(f("next.config.mjs")), "nextjs");
check("next.config.cjs too", detectFrameworkFromFiles(f("next.config.cjs")), "nextjs");

// ── App Router shapes, including route groups ──────────────────────────────
check("a plain app/layout.tsx", detectFrameworkFromFiles(f("app/layout.tsx")), "nextjs");
check("a route group's layout", detectFrameworkFromFiles(f("app/(marketing)/layout.tsx")), "nextjs");
check("a route group's page", detectFrameworkFromFiles(f("app/(dashboard)/page.tsx")), "nextjs");
check("a Route Handler alone", detectFrameworkFromFiles(f("app/api/orders/route.ts")), "nextjs");

// ── the dependency, when no structural file survived selection ─────────────
check(
  "package.json naming next",
  detectFrameworkFromFiles({ "package.json": '{"dependencies":{"next":"15.0.0"}}' }),
  "nextjs",
);

// ── React/Vite must NOT be misread as Next ─────────────────────────────────
check("a Vite app stays react", detectFrameworkFromFiles(f("src/main.tsx", "index.html")), "react");
check(
  "a Hono backend on :3001 stays react",
  detectFrameworkFromFiles(f("src/main.tsx", "server/index.ts")),
  "react",
);
check(
  "package.json without next stays react",
  detectFrameworkFromFiles({ "package.json": '{"dependencies":{"hono":"4.0.0"}}' }),
  "react",
);
// "next" must match as a dependency name, not anywhere in the file.
check(
  "a package merely mentioning the word next is not Next.js",
  detectFrameworkFromFiles({ "package.json": '{"dependencies":{"next-tick-polyfill-x":"1.0.0"}}' }),
  "react",
);
check("an empty project falls back to react", detectFrameworkFromFiles({}), "react");

// ── TanStack still wins outright ───────────────────────────────────────────
check(
  "TanStack is checked first",
  detectFrameworkFromFiles(f("app/routes/__root.tsx", "app/layout.tsx")),
  "tanstack",
);

console.log(failures === 0 ? "\nAll framework-detect cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
