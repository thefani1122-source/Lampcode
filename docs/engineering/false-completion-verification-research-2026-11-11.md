# False Completion Research — Evidence-Backed Agent Verification

**Date:** 2026-11-11  
**Status:** Research and architecture recommendation — no implementation changes made.  
**LampCode baseline:** `main`, reviewed during the 2026-11-11 architecture review.  
**Related documents:**
- [Capability integration review](./lampcode-capability-integration-review-2026-11-11.md)
- [Engineering reliability improvements from field feedback](./field-feedback-improvements.md)

## Executive finding

The problem described by engineers is not just that an AI model sometimes writes incorrect code. The deeper failure is that the system lets the same agent that interprets the request and implements the change effectively decide whether the task is complete, without requiring independent evidence that the requested behaviour works.

A compiler can prove syntax/type compatibility. A passing unit test can prove that one test passed. A static wiring scan can detect some unconnected controls. None alone proves that the user-requested workflow works end to end.

**Recommended product direction: Proof-Carrying Completion.** Every material acceptance criterion should be linked to an independently executed verification and evidence from the exact final project version. The model may describe its work, but the backend's evidence ledger—not the model's final sentence—decides whether LampCode can report the work as complete.

This should complement and extend LampCode's current systems, not replace them with one giant reviewer model.

## 1. What the current LampCode system already does

This is not a greenfield problem. Existing capabilities include:

- Acceptance criteria extraction from the raw user prompt in `src/verify/completion-audit.ts`.
- A separate completion-audit dispatch that reads the delivered file set and existing gate results.
- Fail-closed verdict parsing: the auditor's missing/invalid/uncheckable claims default to `unverified`.
- Separate `proven`, `contradicted` and `unverified` states.
- Corroboration of quotations and missing symbols against actual file contents.
- A fake-persistence detector that can downgrade evidence from a browser-only stand-in.
- Syntax checks, TypeScript checks, tests, page rendering, import resolution, wiring analysis, dead-code analysis and security repair.
- `browser_interact`, a real Playwright journey tool with ordered steps.
- An automatic Playwright interaction probe that tries a bounded number of buttons, links and forms on declared routes.
- A real-build evaluation harness under `scripts/eval/`, with 21 fixed tasks, smoke/core/hard tiers, screenshots and a browser-journey scoring mechanism.

Important source files:
- `src/verify/completion-audit.ts`
- `src/verify/audit-repair.ts`
- `src/verify/journey.ts`
- `src/agents/tools/browser-interact.ts`
- `src/verify/interactions.ts`
- `src/agents/tools/shared.ts`
- `src/server/routes/build.ts`
- `scripts/eval/tasks.ts`
- `scripts/eval/run.ts`
- `scripts/eval/score.ts`

## 2. The exact gap found in the current evidence path

### 2.1 Completion audit proves code evidence more readily than runtime behaviour

The current completion audit receives:
- raw-prompt criteria;
- the final in-memory file set;
- `check_page`, `check_types` and `run_tests` verdict text, including staleness labels.

Its `GATE_EVIDENCE` allowlist currently contains only `check_page`, `check_types` and `run_tests`. The parser accepts a model verdict as `proven` when it cites a known generated file or one of those gates.

That is an important anti-hallucination safeguard: invented file paths do not count. But a real file can still contain a function, handler or endpoint that is not correctly connected to the user's requested workflow. A citation to that file proves the cited file exists; it does not prove the workflow works.

The completion audit currently does not accept a verified `browser_interact` journey or the final interaction-probe report as criterion-linked evidence. The tool can run during the build, but the model must choose to call it, and its result is not a first-class evidence record in the completion audit.

### 2.2 Generic interaction probing is not a product-acceptance test

The current Playwright interaction probe:
- visits declared routes;
- operates a bounded number of buttons, links and forms;
- uses visible changes, network activity, DOM mutations and storage observations to avoid false accusations;
- skips uncertain cases rather than claiming a control is broken.

This is useful for detecting some inert controls. It deliberately does not know what the application is supposed to do. A button that opens a modal can be counted as responsive even if the modal's Save action does not persist the data. A form can produce a toast while the requested server-side write is missing. A sequence such as create → edit → reload → filter → delete cannot be inferred from a single isolated click.

### 2.3 Journey infrastructure exists, but coverage is sparse

`browser_interact` and the typed `JourneyStep` runner already provide a practical Playwright foundation.

The evaluation suite currently defines 21 tasks, but only one task (`counter-journey`) has an authored end-to-end browser journey. The runner can execute these journeys and fail the evaluation when they fail; the pattern simply has not yet been expanded across the important workflows.

### 2.4 Test-shape checks are not test-adequacy proof

`hollow-tests.ts` identifies syntactically hollow patterns such as empty tests, skipped tests, no assertions, literal-only assertions and tests that appear not to import application code. That is valuable and conservative. It cannot prove that a non-empty assertion would fail when the important behaviour is broken.

This is where mutation testing and property/model-based testing can add evidence.

## 3. Strongest research result: OpenHands Verification Stack

### Repositories

- [OpenHands/extensions](https://github.com/OpenHands/extensions) — MIT.
- [QA Changes plugin](https://github.com/OpenHands/extensions/tree/main/plugins/qa-changes)
- [QA methodology skill](https://github.com/OpenHands/extensions/tree/main/skills/qa-changes)
- [PR Review plugin](https://github.com/OpenHands/extensions/tree/main/plugins/pr-review)
- [Code review skill](https://github.com/OpenHands/extensions/tree/main/skills/code-review)
- [Iterate skill](https://github.com/OpenHands/extensions/tree/main/skills/iterate)

OpenHands explicitly separates two jobs:
1. **Code review:** read the diff, understand repository conventions and data/control flow, then report material, evidence-backed defects.
2. **Functional QA:** set up and run the software, operate the changed behavior like a user, use a real browser for UI changes, or real HTTP/CLI operations for API/backend/CLI changes, and post observed evidence.

The QA plugin's documented four phases are:
1. Understand the change and identify its real entry points.
2. Set up the environment and build.
3. Exercise the changed behavior as a real user would.
4. Report a verdict with commands, actual outputs and screenshots/evidence.

Its instructions explicitly say that a green test suite is not a QA finding. For bug fixes, it asks for the same scenario to be reproduced before and after the fix. It also has a give-up policy: after materially different attempts fail, switch approach; if independent approaches also fail, report the work as unverified rather than pretend it passed.

The PR Review plugin complements QA:
- traces the changed data/control flow rather than reviewing files in isolation;
- checks callers, state transitions, compatibility and lifecycle;
- requires regression tests to reach the behaviour and fail when the defect returns;
- can require an Evidence section with screenshots/video or actual commands and outputs;
- optionally delegates large reviews to file-level sub-agents, then requires the coordinator to re-verify and consolidate findings.

The QA GitHub Action is a working implementation, not just a prompt: it runs an OpenHands agent with browser tools, bounded LLM budget, iteration limit and timeout, and uploads logs/artifacts. Its GitHub workflow deliberately uses `pull_request`, not `pull_request_target`, because it executes untrusted PR code; fork PRs without secrets are skipped rather than run with privileged credentials.

**LampCode fit:** Very high as an architectural pattern. Do not copy the whole Python/OpenHands runtime into LampCode. Reuse the separation of reviewer vs functional QA, the real-user exercise method, the evidence report format and the explicit unable-to-verify behaviour. LampCode already has E2B + Playwright; a backend-owned QA coordinator can call those facilities without exposing another 500-iteration agent or 35 extra tools to the builder.

References:
- https://www.openhands.dev/blog/20260506-the-verification-stack
- https://www.openhands.dev/blog/20260305-learning-to-verify-ai-generated-code
- https://github.com/OpenHands/extensions/tree/main/plugins/qa-changes
- https://github.com/OpenHands/extensions/tree/main/plugins/pr-review

## 4. Supporting repositories and their precise roles

### 4.1 StrykerJS — test adequacy through mutation testing

Repository: https://github.com/stryker-mutator/stryker-js  
License: Apache-2.0.  
Relevant package: `@stryker-mutator/vitest-runner`.

Stryker deliberately mutates production code (for example, changes a comparison or removes a condition) and runs the test suite. If tests still pass, the mutant survived: the tests may not detect that class of defect. This is stronger than line coverage for answering whether tests actually protect important logic.

**LampCode use:** Run selectively on newly written or changed domain logic, calculations, authorization helpers and important reducers—not on every file in every build. Use mutation score and surviving-mutant examples to decide whether tests need strengthening.

**Compatibility caveat:** The inspected current StrykerJS core and Vitest runner package version is 10.1.1 and declares Node >=22.0.0. LampCode currently declares Node >=20.18.1. The Vitest runner peer range includes Vitest >=2.0.0 (LampCode's baked template currently uses Vitest 2.1.8), but the Node engine is a real integration constraint. Do not install it into the current production runtime until either the runtime is moved to Node 22+ and verified, or Stryker is run in a separately versioned worker/container.

**Limit:** Mutation testing checks whether tests kill the mutations Stryker creates. It does not prove every user requirement or every possible bug is covered; equivalent mutants and the selected mutation operators need care.

References:
- https://stryker-mutator.io/docs/
- https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- https://github.com/stryker-mutator/stryker-js/tree/master/packages/vitest-runner

### 4.2 fast-check — property-based and model-based stateful tests

Repository: https://github.com/dubzzz/fast-check  
License: MIT.  
Inspected package version: 4.10.2; its package declares Node >=12.17.0.

fast-check works with common JavaScript test runners, including Vitest. It generates many inputs instead of relying only on hand-picked examples, shrinks failures to smaller counterexamples, and supports model-based command sequences. Its asynchronous and scheduled model runners can exercise sequences and concurrency-sensitive operations.

**LampCode use:** For a feature with meaningful state transitions, define an independent, small reference model and commands (create, edit, delete, reload, filter, move, submit, retry). Run generated command sequences against the real implementation and compare externally observable state with the model. Apply this to tasks, kanban boards, project trackers, forms, carts and similar stateful apps.

The model must remain simpler and independent of the implementation. Copying the implementation into the test model merely reproduces the same blind spot.

References:
- https://fast-check.dev/docs/introduction/
- https://fast-check.dev/docs/advanced/model-based-testing/
- https://github.com/dubzzz/fast-check

### 4.3 Schemathesis — API property testing and stateful workflows

Repository: https://github.com/schemathesis/schemathesis  
License: MIT.

Schemathesis generates tests from OpenAPI, GraphQL or gRPC descriptions. It sends actual requests with generated edge-case inputs, checks response schemas and can chain operations into realistic workflows. Its documented findings include server errors, schema violations, validation gaps, integration mismatches and object-level authorization problems.

**LampCode use:** Start with generated FastAPI projects where OpenAPI is available. Consider Hono/Node projects only when LampCode can provide an accurate OpenAPI document. Run against a dedicated ephemeral/local test backend and isolated data, never a user's production database. The official README warns that generated requests may create/change/delete data and should target development or staging environments.

**Limit:** It requires an API description; it does not automatically infer all business requirements. Schema conformance does not prove that a user story is complete.

References:
- https://github.com/schemathesis/schemathesis
- https://schemathesis.readthedocs.io/en/stable/
- https://schemathesis.readthedocs.io/en/stable/explanations/stateful/

### 4.4 Pact JS — consumer/provider contract verification

Repository: https://github.com/pact-foundation/pact-js

Pact is consumer-driven contract testing. The consumer tests its actual API client against a mock provider and produces an interaction contract. Provider verification then replays those interactions against a locally running provider and checks the actual response.

**LampCode use:** Consider it for apps with a clear frontend API client and backend service boundary, especially where separately generated components drift in HTTP method, route, payload, status or response shape. It can catch a frontend/backend mismatch that compiles and that a simple route-existence scan may miss.

**Limit:** Pact validates the specific interactions encoded by the consumer contract. It does not discover missing user requirements, test every business workflow, or prove the real database side effect unless the provider-state/test design includes it. It is not necessary for every small single-sandbox frontend.

References:
- https://docs.pact.io/
- https://docs.pact.io/implementation_guides/javascript/docs/consumer
- https://docs.pact.io/implementation_guides/javascript/docs/provider

### 4.5 OpenHands Critic 4B — agent-trajectory risk signal

Model: https://huggingface.co/OpenHands/openhands-critic-4b-v1.0  
Rubric/prompt code: https://github.com/OpenHands/critic-rubrics  
Model card license: MIT.

The model card describes a 4B-parameter Qwen3-4B-based classifier with 26 outputs (25 behavioural rubric features plus one task-success prediction). It scores agent trajectories—conversation, tool calls and actions—and returns probabilities/rubric predictions. It is intended to flag risky or low-quality trajectories and can support continue/stop/refine or attempt selection.

**LampCode use:** Optional later experiment. A cheap trajectory/rule gate can flag patterns such as: editing an existing project without reading files; exhausting turns with pending tool calls; writing repeatedly without a fresh page/type check; never exercising a required user flow; or reporting completion despite an unavailable/stale verifier.

**Critical limitation:** A critic score is a prediction, not proof that the application works. It must never override failed or missing execution evidence. Hosting the 4B model also requires separate inference infrastructure (the model card documents vLLM serving); do not add GPU infrastructure before the deterministic evidence system is working.

The `OpenHands/critic-rubrics` source repository was archived on 2026-08-03. Treat the rubric code as reference material, not an assumed actively maintained dependency.

References:
- https://huggingface.co/OpenHands/openhands-critic-4b-v1.0
- https://github.com/OpenHands/critic-rubrics

## 5. Recommended LampCode architecture: Proof-Carrying Completion

### Layer A — Acceptance criteria with verification contracts

Keep the existing raw-prompt acceptance extraction. Extend each criterion with:
- criterion ID and exact user-facing wording;
- type: visual, behaviour, data/persistence, logic, API/integration, security;
- observable preconditions and expected outcome;
- one or more required verification methods;
- risk/severity and whether evidence is mandatory.

Do not derive all tests from the builder's plan or final summary. The builder's misunderstanding is exactly what the verifier must be able to discover.

### Layer B — Independent QA-plan generation

A separate, read-only QA planner receives:
- raw user request and extracted criteria;
- the final changed-file manifest/diff and route/API inventory;
- project-specific QA guidance.

It proposes concise, structured journeys. It cannot edit project code, create a fake implementation, or mark its own plan as passed. The plan should name expected observable results, not just repeat the implementation description.

### Layer C — Real execution

Reuse the existing E2B and Playwright infrastructure:
- visit affected routes;
- perform the actual requested workflow;
- verify visible state after each critical action;
- reload/navigate away and back when persistence is required;
- test error and boundary cases;
- for APIs, make real HTTP requests and inspect status/body;
- where relevant, verify actual persisted state in a dedicated test database/tenant;
- for auth/security, include negative tests as well as valid-user paths.

For a visual requirement, collect screenshots and optionally use the previously researched Midscene approach. Visual review and functional workflow testing remain distinct evidence types.

### Layer D — Test adequacy and edge cases

Use tools conditionally:
- fast-check for stateful logic and generated command sequences;
- Stryker for critical logic with meaningful tests, subject to Node 22 compatibility or an isolated runner;
- Schemathesis for APIs with accurate OpenAPI/GraphQL/gRPC contracts and disposable test data;
- Pact only for distinct consumer/provider boundaries where contract drift is a demonstrated risk.

Do not require these tools for simple static landing pages. Task/risk classification should decide.

### Layer E — Change-aware code review

For existing-project edits and complex feature builds, inspect the actual diff and trace changed data/control flow:
- new functions and handlers have callers;
- frontend calls match declared backend routes;
- response data is actually consumed and state is updated;
- new paths are imported/rendered;
- edits preserve existing callers and working functionality;
- tests reach the changed behavior, not only a mocked copy.

Use the OpenHands PR Review methodology as reference. LampCode's existing `review_code`, `impact_analysis` and `code_intel` can support this, so avoid running a second expensive whole-project reviewer on every low-risk build.

### Layer F — Evidence ledger and final status gate

Store one record per criterion with:
- criterion ID;
- status: `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED` or `UNVERIFIABLE`;
- verifier and method;
- exact journey steps or command;
- expected and actual observations;
- screenshot/trace/API response/artifact reference;
- project version/file fingerprint against which the check ran;
- timestamp, duration and any retry.

Only an execution result from the final project version may satisfy a mandatory runtime criterion. If any later repair changes relevant files, affected evidence becomes stale and must be re-run.

A file citation means **implementation evidence**, not runtime proof. Keep these separate.

The final completion statement should be generated from this ledger:
- **Complete:** all required criteria have fresh PASS evidence.
- **Partial:** some requirements pass, but at least one required criterion fails or remains unverified.
- **Blocked:** required verification could not run due to a genuine environment/credential/infrastructure blocker.
- **Failed:** one or more required behaviours were demonstrated to fail.

The builder may narrate progress, but it cannot override this status. Never translate an unavailable test, a test suite with no tests, a stale result, or a source-code citation into a runtime PASS.

## 6. Implementation order

### P0 — Evidence wiring (before adding libraries)
1. Extend the completion-audit contract to accept structured journey/API/visual evidence.
2. Distinguish source-code evidence from runtime evidence.
3. Add a backend verification coordinator that executes required journeys independently of the builder.
4. Ensure journey evidence is tied to the final file version and invalidated by later writes.
5. Generate the user's final "done" status from the evidence ledger only.

This closes the exact gap found in the current audit: `browser_interact` exists, but criterion-linked journey evidence is not currently part of `GATE_EVIDENCE`.

### P1 — Expand journeys in the existing evaluation harness
Add independent journeys to the current 21 evaluation tasks, beginning with:
- todo: create, complete, filter, reload, delete;
- settings: change, navigate away, reload, verify saved value;
- project tracker: create task, start/stop timer, navigate, verify elapsed/persisted state;
- CRM: create/edit customer, search/filter, verify persisted values;
- form builder: configure fields, submit valid/invalid input, verify saved result;
- FastAPI: create/read/update/delete, malformed input, unauthorized access.

Measure false-completion rate, real journey pass rate, journey-unavailable rate, regressions, cost and duration. Add deliberately incomplete/miswired fixtures and ensure the evaluator catches them.

### P2 — Add test-quality tools selectively
- fast-check: pilot on one stateful feature and one async/concurrency-sensitive feature.
- Stryker: pilot in a Node 22+ isolated worker on one important TypeScript logic module.
- Schemathesis: pilot against a generated FastAPI/OpenAPI app with disposable data.
- Pact: defer until frontend/backend contract drift is demonstrated in builds.

### P3 — Independent review and trajectory critic
- Add risk-based diff review using the OpenHands review methodology.
- First implement deterministic trajectory rules using events LampCode already records.
- Evaluate OpenHands Critic 4B only if a cheap additional predictor demonstrates measurable reduction in false completions.

## 7. What not to do

- Do not install every candidate repository into every generated app.
- Do not add a new model-facing tool for each verifier; invoke them from the backend and return compact findings.
- Do not accept a model's claim, a passing compile, line coverage, a screenshot alone, or a source-file citation as universal proof.
- Do not run mutating API fuzzers against production/user data.
- Do not let a QA worker inherit production credentials or secrets from the generated app sandbox.
- Do not make every visual/design concern a hard block; use the user's actual requested criteria and risk.
- Do not claim the system can prove software bug-free. Measure and reduce false completion with explicit evidence and known limits.

## Final recommendation

**Build the evidence link first.** LampCode already has most of the necessary raw components: acceptance extraction, Playwright, journey execution, test runner, static wiring checks, completion audit and bounded self-fix. The highest-value missing piece is making independently executed user journeys first-class evidence that the completion audit and final status must obey.

After that, add fast-check and targeted mutation/API testing where the change deserves it. Adopt the OpenHands QA/review separation as a design pattern, not as a second full agent runtime.

This creates a defensible product promise: **LampCode does not call a feature complete because code was written or tests turned green; it reports completion only to the extent that the requested behaviour was actually exercised and evidenced.**

## Repository evidence inspected

- LampCode `src/verify/completion-audit.ts`, `src/verify/journey.ts`, `src/verify/interactions.ts`, `src/agents/tools/browser-interact.ts`, `src/agents/tools/shared.ts`, `src/server/routes/build.ts`, `scripts/eval/tasks.ts`, `scripts/eval/run.ts`, `package.json`.
- OpenHands QA and PR Review plugin scripts, actions and workflow files under `OpenHands/extensions`.
- StrykerJS core and Vitest runner package manifests.
- fast-check package manifest and model-based testing documentation.
- Schemathesis README and official documentation.
- Pact JS consumer/provider documentation.
- OpenHands Critic 4B model card and critic-rubrics repository status.

*Research only. No dependency, source file, model, sandbox template, CI workflow or deployment was changed for this investigation.*
