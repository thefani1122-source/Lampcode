/**
 * "Component added but never wired in" — and the three things that are not it.
 *
 * Measured against a real build on 2026-10-23: a working calorie tracker was
 * told it had 29 unwired components, nearly all of them shadcn primitives
 * (Card, CardHeader, DialogPortal, SelectGroup) plus type exports like
 * ButtonProps. The warning was wrong, it was alarming, and it drove a repair
 * dispatch at code that was never broken.
 */

import { findOrphanExports } from "../src/agents/manifest-generator.js";

let failures = 0;
let checks = 0;
function ok(name: string, pass: boolean, detail?: string): void {
  checks++;
  if (pass) { console.log(`✔ ${name}`); return; }
  failures++;
  console.log(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
}
const names = (files: Record<string, string>) =>
  findOrphanExports(files).map((o) => `${o.name}`).sort();

// ── the finding it exists for ───────────────────────────────────────────────

ok("a component nobody imports is reported",
  names({
    "src/App.tsx": `import { Used } from "./components/Used";\nexport default function App() { return <Used />; }`,
    "src/components/Used.tsx": `export function Used() { return <div />; }`,
    "src/components/Lonely.tsx": `export function Lonely() { return <div />; }`,
  }).join(",") === "Lonely");

ok("a component that IS imported is not reported",
  names({
    "src/App.tsx": `import { Hero } from "./components/Hero";\nexport default function App() { return <Hero />; }`,
    "src/components/Hero.tsx": `export function Hero() { return <div />; }`,
  }).length === 0);

// ── the three false positives ───────────────────────────────────────────────

{
  // shadcn's button.tsx, as generated apps actually contain it.
  const files = {
    "src/App.tsx": `import { Button } from "./components/ui/button";\nexport default function App() { return <Button />; }`,
    "src/components/ui/button.tsx":
      `export interface ButtonProps { variant?: string }\n` +
      `export const buttonVariants = () => "";\n` +
      `export function Button() { return <button />; }`,
    "src/components/ui/card.tsx":
      `export function Card() { return <div />; }\n` +
      `export function CardHeader() { return <div />; }\n` +
      `export function CardContent() { return <div />; }`,
  };
  ok("a design-system primitive file reports nothing",
    findOrphanExports(files).length === 0,
    JSON.stringify(names(files)));
}

{
  const files = {
    "src/App.tsx": `export default function App() { return null; }`,
    "src/components/Panel.tsx":
      `export interface PanelProps { title: string }\n` +
      `export type PanelKind = "a" | "b";\n` +
      `export function Panel() { return <div />; }`,
  };
  ok("a type export is never an unwired component",
    names(files).join(",") === "Panel",
    JSON.stringify(names(files)));
}

{
  const files = {
    "src/App.tsx": `export default function App() { return null; }`,
    "src/components/Thing.tsx":
      `export const thingHelper = () => 1;\n` +
      `export function Thing() { return <div />; }`,
  };
  ok("a lowercase helper is not a component",
    names(files).join(",") === "Thing",
    JSON.stringify(names(files)));
}

// ── the regression this file is really guarding ─────────────────────────────

{
  // The exact shape of the production report. Only the two feature components
  // are real; everything else was noise.
  const ui = (n: string[]) => n.map((x) => `export function ${x}() { return <div />; }`).join("\n");
  const files = {
    "src/App.tsx": `export default function App() { return null; }`,
    "src/components/ui/button.tsx": `export interface ButtonProps {}\nexport const buttonVariants = () => "";\n${ui(["Button"])}`,
    "src/components/ui/card.tsx": ui(["Card", "CardHeader", "CardFooter", "CardTitle", "CardDescription", "CardContent"]),
    "src/components/ui/dialog.tsx": ui(["Dialog", "DialogPortal", "DialogOverlay", "DialogClose", "DialogTrigger", "DialogContent"]),
    "src/components/ui/select.tsx": ui(["Select", "SelectGroup", "SelectValue", "SelectTrigger", "SelectContent", "SelectLabel"]),
    "src/components/AddFoodDialog.tsx": ui(["AddFoodDialog"]),
    "src/components/CalorieRing.tsx": ui(["CalorieRing"]),
  };
  const found = names(files);
  ok("the 29-finding report reduces to the two real ones",
    found.join(",") === "AddFoodDialog,CalorieRing",
    `${found.length} found: ${found.join(", ")}`);
}

console.log(`\n${checks} orphan-export checks, ${failures} failed`);
if (failures > 0) process.exit(1);
