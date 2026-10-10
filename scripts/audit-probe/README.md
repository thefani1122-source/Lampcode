# The completion-audit probe set

Answers one question the eval structurally cannot: **does the audit notice when a
requirement is missing?**

You cannot make a model forget to order, so this works in reverse. It takes one
real generated project, MUTATES it in ways this repo has actually measured,
keeps the criteria fixed, and checks whether the audit's verdict changes.

It runs the **unmutated original too**, and that half matters as much. It
measures PRECISION — which is what Finding 6 was: a confident, specific and
entirely false `contradicted` over working code. A recall number on its own
would hide exactly that failure.

```bash
npm run audit-probe     # needs LLM_* in .env; ~$0.02 and about a minute
```

## What it needs

`LLM_ENDPOINT_URL`, `LLM_API_KEY`, `LLM_MODEL_NAME` in `.env`. It does **not**
use the eval's HTTP login: it calls `auditCompletion` directly, because the
point is the audit's judgement rather than the build path around it. No builds
are run and no sandbox is started.

The dispatcher here is a stand-in that does only what the audit asks of one —
it reads the real `audit` system prompt out of `prompt-builder.ts` as TEXT
(`SYSTEM_PROMPTS` is not exported, and importing that module for one string is
the coupling this repo keeps regretting) and appends the same JSON-output line
the real assembly does.

## The fixture is FIXED, and that is the point

`fixture/files.json` and `fixture/criteria.json` are one real build — NOTEBOX, a
notes app, 11 files, 11 criteria, all 11 proven when unmutated. Both are
committed deliberately. Re-generating the fixture makes every stored run
incomparable, the same reason `scripts/eval/tasks.ts` says never to edit a
task's prompt. If the fixture must change, add a second one beside it.

## The mutations

Each is a failure this repo has measured on a real build, not an invented one:

| mutation | shape | expects |
|---|---|---|
| `no-persistence` | strip localStorage, keep everything around it | R3 |
| `no-cap` | delete the numeric cap | R4, R5 |
| `handler-never-attached` | the handler is defined and never wired up | R8 |
| `no-inline-error` | remove the conditional warning branch | R7 |
| `no-sort` | remove the ordering | R9 |

A mutation that stops matching its target is a silent no-op, which would read as
the audit missing something it was never shown. If you change the fixture, check
that each mutation still applies before trusting a miss.
