# Lampcode — what is left, and who does it

Working plan as of **2026-10-11**. `CLAUDE.md` holds what is true now; `HISTORY.md` holds the
evidence. This file holds only **what has not happened yet** and who it is assigned to, so the
owner, Claude and Codex are reading one list instead of three.

Delete a row when it is done and the gate below it passed. Add the evidence to `HISTORY.md`, not
here.

## THE DEADLINE — 2026-10-23, and what it cuts

Both AI plans (Claude and Codex) end on **23 October**. Claude's weekly budget is 86% spent.
The owner's goal: **launch, and have real users test it, before the plans end.** That is
**11 days** from 2026-10-12.

**That reorders everything, because real-user testing cannot come after the engineering.** The
door has to open first. A2 and A3 are config flags that can be done today; every day they stay
shut is a day of user feedback that will never exist.

It also makes most of the B list free. Those paths are unproven because proving them costs a
build — and **a real user's build IS that build.** Ten users building is the measurement, and it
costs nothing extra.

### Ships before the 23rd

| | What | Who |
|---|---|---|
| 1 | **A2 + A3** — open the door, un-pause Supabase | Owner, today |
| 2 | **A1** — a good model (Anthropic key) | Owner, this week |
| 3 | Wire `wiring.ts`, `hollow-tests.ts`, `interactions.ts` into the build | Claude |
| 4 | **C4 — the Receipt** | Codex |
| 5 | **C3 — the Contract**, only if 1–4 are done | Codex |

### Cut, and these are deliberate

| Cut | Why it is safe to cut |
|---|---|
| **C5 provider boundary** | **It is not actually a prerequisite.** `dispatcher.ts` already supports the Anthropic direct API for the paid tier (CLAUDE.md, "Model availability"), so with an Anthropic key the swap is a config change, not a refactor. The 3,624-line file stays ugly and ships. |
| **C6 research-before-build** | Real improvement, zero launch risk in deferring. Prompt text, where a rushed change is most dangerous. |
| **C7 decision controller** | A bet, and its gate is a paid 20-task eval. There is no budget for the eval and no time to honour "delete it if it loses". |

**If a choice has to be made between shipping an item and having real users, the users win.** An
unlaunched product with a better turn-cap policy is worth nothing on 24 October.

## How we work right now

The owner's Claude weekly budget is nearly spent, so the split is:

- **Codex implements** — self-contained work with a strong test guard.
- **Claude specs and reviews** — writes the task prompt, then verifies on Linux and fixes.
- **Claude keeps** anything that is prompt text (trap 4 is most dangerous there) or that needs a
  paid eval to prove.

**Push after every task, to `claude/magical-fermat-zr857z`.** Not in a batch. Claude can only
review what is pushed, the branch is the only durable record, and one task's diff is reviewable
where a batch is not.

**Codex runs on Windows; Railway runs Linux.** `npm run build` failing with an esbuild
parent-directory denial, and `npm test` needing a username-lookup workaround, are Windows
environment problems. Do not stop for them — report them and push; Claude re-runs all three
gates on Linux, which is the environment that matters.

Every task ends with: `npm run typecheck`, `npm test`, `npm run build`, a probe against REAL
code, and an explicit list of what was **not** verified. "It should work" is not a result.

---

## A. Owner actions — these block everything else

| # | Action | Why it blocks |
|---|---|---|
| A1 | Money → **Anthropic API key** | The fastest route to a good model. `dispatcher.ts` already supports it, so it is a config change, not a build. Everything about output quality is downstream of this. |
| A2 | `WAITLIST_MODE=false` + `VITE_WAITLIST_MODE=false` | The product is **closed**. `/api/build/fast` is blocked for non-admins. |
| A3 | **Un-pause the preview Supabase** | It is paused, so any generated app that needs persistence is a lie. |
| A4 | Connect a **Vercel token** | Without it the deploy path cannot be tested at all. |

**Gate:** a stranger types a prompt, gets a working app, and its persistence actually works.

---

## B. Needs one real build to prove — code is written, money is not spent

These are **not unfinished**. They are finished and unproven, which is a different claim and the
distinction this project exists to defend.

| # | What | Why it is unproven |
|---|---|---|
| B1 | The wiring **repair loop's dispatch path** | Has never executed. The analyser is measured on real code; the loop that fixes what it finds has not run once. |
| B2 | The `API_BASE` fullstack fix | Prompt text. Proving it means generating a fullstack app and loading its **production** bundle. |
| B3 | The `app.ts` / `index.ts` split | Needs a build to confirm the preview still comes up. `e2b-service.ts` detection was checked by reading, not by running. |
| B4 | `api/[...route].ts` routing on Vercel | No source settles whether it catches `/api/*` in a project that is also a Vite build. Needs a real deploy. Isolated in `vercelScaffold` — one function, one fix. |
| B5 | Findings 16 and 19 | Carried over; never exercised by a build. |

---

## C. Code still to write

Ordered by what moves the owner's two stated goals: **every output solid**, and **long-running /
complex projects**.

| # | What | Who | Note |
|---|---|---|---|
| C1 | **Hollow-test check** (`src/verify/hollow-tests.ts`) | Codex | Done locally, **not pushed**, and its probe used the wrong corpus — see below. |
| C2 | **`check_page` must interact** — click every button, visit every route, assert something changed | Codex | Today it only checks that a page *rendered*. This is the cheapest half of the "make the environment legible to the agent" lesson, and it lands directly on the multi-page goal. |
| C3 | **The Contract** — show the extracted criteria BEFORE the build, let the user edit them | Codex + Claude review | `extractCriteria` already runs early and in parallel (`build.ts:1191`); it is only *awaited* at the end. So this is about showing and editing, not about new extraction. |
| C4 | **The Receipt** — per-requirement evidence in the UI (`vibe-coder-suite`) | Codex | `formatAuditForUser` and `formatWiringForUser` already produce user-language lines. The gap is a card, not infrastructure. |
| C5 | **Provider boundary out of `build.ts`** | Codex, precise spec | `build.ts` is **3,624 lines** — orchestration, gates, repair loops and provider logic fused. The M2.5 → Anthropic swap runs straight through it. Only the provider seam; not a full refactor. |
| C6 | **Research before code** — the agent establishes what the thing *is* before writing it | **Claude** | `fetch_reference` exists but is optional and needs a URL from the user. The owner's point: the user often does not know what they want, so the agent must work out what this kind of app contains, what people expect in it, and what the comparable is. This is prompt text, where trap 4 bites hardest. |
| C7 | **Per-round decision** — `continue / verify / escalate / ask / finish` | **Claude** | Replaces `AGENTIC_MAX_TURNS` as the real control. A build died at 40/40 rounds having used **4% of the cost ceiling** — the cap, not the work, ended it. This is why long and multi-page apps arrive unfinished, so C7 and the long-running goal are one item. Signals already exist in `build_outcome`: unproven criteria, churn, staleness, rounds, cost. |
| C8 | **Decision log** in `build_outcome` | Claude | Every decision, its inputs, its outcome. This is the trajectory dataset, collected free from normal product use. |
| C9 | `MODEL_PRICING` row before any model switch | Claude | A miss falls to `DEFAULT_PRICING` ($1/$4) with only a warning, mispricing every build and the cost guard with it. |

**Gate for C7, and hold it:** on the 20-task eval, equal or better completion at lower cost than
the fixed turn cap. If not — **delete it**.

### C1 — what to fix before it lands

The real-code probe returned **18 files, 0 findings**, and that proves almost nothing. The fault
is in the spec, not the implementation: this repo's own `scripts/*.test.ts` use a custom
`check()` / `ok()` harness and contain **no `it(` and no `expect(`**, so rules that look for
those were never going to fire. Codex caught this ("these custom harnesses do not establish
recall on generated applications") and was right.

Generated apps use **vitest**. The probe has to run against vitest-shaped test files — real
generated ones if any are stored, otherwise realistic fixtures — and the recall question has to
be answered there before this is wired into a build.

---

## Deliberately NOT doing

Saying no is half the plan. Each of these assumes something Lampcode does not have.

| Not doing | Why |
|---|---|
| Model routing | Blocked by entitlement, not engineering: 38 open-weight models reachable, **zero** premium. Routing inside one capability tier is meaningless. |
| Multi-agent | The ceiling is the turn cap, not coordination. A build costs $0.10 and dies at 40 rounds. |
| Constitution engine | It is a machine-checkable `CLAUDE.md`. The "checkable" part is good and cheap; it is not a frontier. And a generated app's user never wrote a constitution. |
| Rollouts / post-PR | There is no production to watch. |
| Context control | A generated app is 20–25 files. This is a 100k-file repo's problem. |
| Full monolith refactor | Only the provider seam (C5). The rest later. |

---

## The risk the owner should keep in view

**The Receipt makes the model's weakness public.** M2.5 holds 2 of 4 smoke checks today, and the
Receipt turns that into "2 of 4 proven, 2 unverified" where the user can read it.

It should still ship: an honest "2 of 4" beats a false ✅, and only the honest version earns
trust. But it means launch quality becomes measurable in public — which is exactly why **A1 is
load-bearing rather than nice to have.**
