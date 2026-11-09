---
name: product-ui-design
description: Product-level UI/UX design standards for generated React applications, dashboards, SaaS workspaces and authentication screens.
---

# Product UI Design — Required Standard

This skill applies to every new frontend and full-stack application, regardless of whether the user says "beautiful", "modern", "premium" or gives no design adjectives. It complements the user's exact visual requirements; it never overrides them.

## 1. Design before implementation

Before coding, make a short internal design brief:
- Identify the product, primary user, top 2–4 user journeys and the information each screen must prioritise.
- Choose a visual direction that fits the product. Define background/surface/text/primary/accent/semantic tokens, typography roles, spacing rhythm, density, borders, radii and elevation.
- Define the application shell and navigation from the information architecture.
- Describe the composition of every route and how it changes at 1440, 1024, 768 and 390 CSS pixels.
- Reuse one design language across screens. Do not let each component invent its own colours, radii or spacing.

Do not copy a reference product's brand or layout wholesale unless the user asks for a close reproduction. Use references to understand hierarchy, interaction patterns and design quality.

## 2. Authentication pages

Default login/signup/reset screens are focused, card-based experiences:
- Center a content-width form panel in the available viewport. Normal desktop max-width: 420–460px; on mobile use width: 100% with safe side padding.
- The viewport background can be full-screen, but the form card must not become a full-screen stretched form.
- Give the card a clear boundary through surface contrast, subtle border/elevation or a deliberate split layout. Keep field widths, label alignment, button width and vertical rhythm consistent.
- Include brand/product identity, a clear heading, short helper copy, labelled inputs, visible focus, validation and error states.
- Do not add non-working forgot-password, social-login, remember-me or registration actions. If signup is included, make the path between login and signup real.
- A user-requested immersive/split-screen auth concept takes precedence, but the form itself remains readable and constrained.

## 3. Dashboards and app workspaces

A dashboard should help a user understand the current state and take the next useful action:
- Use a persistent AppShell when the product has multiple major sections. Choose sidebar, top navigation or a mobile drawer based on the number of routes and the available viewport.
- The main content must have a clear page header, meaningful primary action and a deliberate hierarchy.
- Summary/KPI cards are supporting information, not the entire dashboard. Include the central working surface appropriate to the product: task board/table, records, schedule, activity feed, chart, pipeline or equivalent.
- Use varied but consistent content density. Avoid a row of identical cards, unstructured whitespace, decorative widgets that do not help the workflow, and generic labels.
- Use real application data. If the backend has no records, show a polished empty state with a real next action; do not seed fake rows into a connected production database.

## 4. Visual system

- Use the existing UI dependencies and components where available (Radix primitives, lucide-react, Tailwind v4). Do not import an uninstalled library.
- Define design tokens once in the app theme; do not scatter arbitrary hex values and inline style decisions across files.
- Use a deliberate type scale: display/page title, section title, body, label and metadata must have visibly distinct roles.
- Establish a consistent spacing scale and grid/container widths. Align page edges, headings, cards, forms and tables to the same layout system.
- Use one primary brand/accent hue plus restrained supporting accents. Keep success/warning/danger colours semantic.
- Body text contrast must meet WCAG AA. Provide visible keyboard focus, semantic HTML, labels, accessible names and touch targets.
- Icons support meaning; do not give every icon a different random colour.

## 5. Responsive behaviour

At desktop (1440px), tablet (1024px), small tablet (768px) and mobile (390px):
- No horizontal page overflow.
- Navigation collapses or transforms intentionally; it must not disappear without an alternative.
- Cards, tables and boards adapt instead of simply shrinking.
- Forms remain usable with readable labels and full-width controls where appropriate.
- Main actions remain visible and reachable; dialogs fit the viewport.
- Test the actual rendered app at desktop and mobile sizes. Do not infer responsiveness from CSS classes alone.

## 6. Visual QA and honest reporting

- Inspect the rendered page, not only the source code. Check the first screen and the main working area below it.
- Review hierarchy, whitespace, content density, alignment, contrast, typography, focus states, clipping and mobile overflow.
- If image input is available, use the screenshot-review tool and fix observed defects.
- If image input is unavailable, run browser-based checks at desktop and mobile widths and inspect computed styles and element bounds. These checks can prove objective layout facts (such as overflow or a stretched login form), but they cannot fully judge aesthetics.
- Never say "visual review passed" when only compilation, route rendering or DOM text checks ran. Mark subjective visual quality as unverified when it was not actually inspected.
- Do not lower the visual standard merely because the app compiles or all buttons respond.
