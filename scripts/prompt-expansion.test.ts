/**
 * Regression coverage for prompt expansion.
 *
 * App-type keyword bundles used to turn a short request into an implicit
 * second specification. These cases ensure product nouns do not silently add
 * domain features, while the narrow, product-agnostic preview-data policy stays.
 */
import { expandUserPrompt } from "../src/agents/prompt-builder.js";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`PASS: ${name}`);
  }
}

const habitPrompt =
  "  Build a habit tracker using my existing PostgreSQL database. Do not add social features.  ";
const habitExpanded = expandUserPrompt(habitPrompt);

check(
  "the original request is preserved byte-for-byte at the beginning",
  habitExpanded.startsWith(habitPrompt + "\n\n"),
);
check(
  "the word habit does not inject a hardcoded sample-habit catalogue",
  !/Drink 2\.5L Water|Morning Workout 30m|Mindfulness Meditation/.test(habitExpanded),
);
check(
  "the word habit does not invent mandatory category, frequency or filter controls",
  !/Frequency badge \(Daily\/Weekly\)|Filter tabs: All \/ Active \/ Completed \/ Categories|fire icon with streak count/i.test(habitExpanded),
);
check(
  "the word task manager does not silently add priorities and due-date sorting",
  !/Priority color-coded badges: High=red|Sort controls: by Priority \/ Due Date \/ Created/.test(
    expandUserPrompt("Build a personal task manager."),
  ),
);
check(
  "the word finance does not inject fixed KPI examples",
  !/Total Balance \(e\.g\. \$4,850\.00\)|Monthly Income \(\$5,200\)/.test(
    expandUserPrompt("Build a finance tracker."),
  ),
);
check(
  "the word dashboard does not mandate a fixed four-KPI/chart composition",
  !/4 KPI cards with trend arrows|SVG bar or line chart \(300×160 px minimum\)/.test(
    expandUserPrompt("Build an analytics dashboard."),
  ),
);
check(
  "the generic collection preview policy remains available",
  habitExpanded.includes("5–8 realistic domain-specific sample records"),
);
check(
  "the generic seed policy still respects explicitly empty first launches",
  habitExpanded.includes("Always respect an explicit request for an empty/blank first launch or no sample data"),
);
check(
  "the generic policy does not replace real backend data with fake database rows",
  habitExpanded.includes("For a real backend/database app, do not write fake rows into the user's database"),
);
check(
  "empty prompts are not expanded into a hidden specification",
  expandUserPrompt("   ") === "   ",
);

if (failures > 0) {
  console.error(`\n${failures} prompt-expansion regression test(s) failed.`);
  process.exit(1);
}
console.log("\nAll prompt-expansion regression tests passed.");
