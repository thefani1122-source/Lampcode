# LampCode Capability Integration Review

**Date:** 2026-11-11  
**Status:** Architecture review and integration proposal — no code or dependencies changed.  
**Repository baseline inspected:** `main` at `bcf143954a8c98bb585b9144a4ffa6330a8c82bb` (during review).

## Executive decision

The five candidate projects are technically usable, but they must not be integrated in the same way. LampCode already has substantial code intelligence, editing safeguards, repair loops, runtime verification and completion auditing. Installing all five as model-facing capabilities would duplicate existing systems and increase tool/context load.

**Recommended direction:** preserve the current LampCode build and repair core; introduce specialist verification workers behind a small backend coordinator. Keep those workers off the model's tool list. They should return compact, structured findings to the existing repair system.

## 1. Existing LampCode architecture inspected

The current build lifecycle is:

1. **Prompt understanding and planning** — build classifier, planner, requirements and relevant project context.
2. **Agent execution** — the model reads, creates and edits files through tools and works in the E2B sandbox.
3. **Database and security checks** — schema consistency, RLS, caller identity, secrets and generated-app security patterns.
4. **Code repair** — fake-persistence, wiring gaps, broken imports, dead code and other bounded repair loops.
5. **Runtime verification** — browser rendering, TypeScript, tests, backend checks and browser interaction probes.
6. **Independent completion audit** — original user requirements are compared with the delivered files; unmet requirements can trigger a bounded repair.
7. **Final outcome** — status, verification results, repair events, token/cost usage and remaining issues are recorded.

Important existing source files:

- `src/server/routes/build.ts` — build orchestration and deterministic repair loops.
- `src/agents/dispatcher.ts` — model dispatch, tool loop, cost/turn limits and tool selection.
- `src/agents/tools.ts` and `src/agents/tools/registry.ts` — tool definitions and handlers.
- `src/agents/tools/edit-file.ts` — exact, unique surgical replacement.
- `src/agents/tools/write-files.ts` — whole-file writes, file preservation/merge and persistence.
- `src/agents/prompt-builder.ts` — model instructions, task profiles, skills and context budgets.
- `src/verify/code-intel.ts` — TypeScript Compiler API symbol/reference understanding.
- `src/verify/architecture.ts` — structural architecture checks.
- `src/verify/wiring.ts` — controls, handlers, routes and endpoints.
- `src/verify/import-graph.ts` — broken relative import detection.
- `src/verify/dead-code.ts` — conservative dead-code checks.
- `src/verify/completion-audit.ts` and `src/verify/audit-repair.ts` — requirements audit and repair.
- `src/verify/render.ts`, `src/verify/interactions.ts` — browser render and interaction evidence.
- `e2b-template/template.ts` and `src/preview/e2b-service.ts` — sandbox, Playwright and preview lifecycle.
- `scripts/eval/` — real-build evaluation harness with smoke/core/hard tiers.

## 2. Existing safeguards and remaining concerns

| Area | Existing implementation | Concern to validate or improve |
|---|---|---|
| Surgical edits | `edit_file` requires an exact, unique match | Model may still choose an unnecessary whole-file replacement |
| File preservation | Project file merging, checkpoints and revert | `write_files` intentionally can replace a whole existing file |
| Syntax/type checks | Syntax validation and TypeScript checks | Validate every agentic write at the right boundary; avoid repeating expensive checks |
| Code understanding | Compiler-backed symbol and reference analysis | Structural coverage outside TypeScript is more limited |
| Change impact | `impact_analysis` identifies dependents and untested files | Make use conditional on genuinely high-risk edits |
| Wiring | Static scans for inert controls, routes and endpoints | A syntactically wired handler can still have incomplete business behavior |
| Dead code | Conservative whole-project analysis | Findings are advisory because false deletion is costly |
| Runtime | Playwright render and interaction probes | Coverage of user-requested flows and visual judgment can be improved |
| Completion | Separate requirement extraction and completion audit | A model-produced criterion and static code evidence do not alone prove live behaviour |

A promising follow-up is a **structural preservation guard**: compare a proposed replacement with a pre-edit symbol/export/route snapshot. Flag unexpected loss of existing functions, exports, handlers or route declarations. Do not block every removal: intentional refactors and explicit deletions must remain possible. Use compiler/AST evidence and tests, not a brittle line-count heuristic.

## 3. Candidate repository assessment

### 3.1 Midscene — visual intelligence

Repository: https://github.com/web-infra-dev/midscene  
License: MIT.  
Verdict: **First integration candidate; isolated proof of concept.**

LampCode already uses Playwright for page rendering and user-like interaction. Midscene may add AI-assisted interpretation of what the browser actually shows: layout hierarchy, visual defects, missing visible content and UI requirements that DOM/error checks cannot judge.

Proposed flow:

1. Finish generation and run existing render checks.
2. Run a visual audit only when the request includes visual/UX acceptance criteria, or when a relevant regression is suspected.
3. Inspect targeted routes/viewports using a dedicated vision-capable model configuration.
4. Normalize findings into route, severity, confidence, affected evidence and likely source files.
5. Send only actionable findings to the existing repair system.
6. Re-run the relevant browser/type/test checks after repair.

Constraints:
- Midscene needs a compatible multimodal model; LampCode's main coding model need not be replaced.
- Its model credentials must stay in a trusted QA worker, not in the generated application sandbox.
- The current Midscene Playwright integration documentation indicates Node 20.19+ or 22.12+; LampCode currently declares Node >=20.18.1. Confirm the actual deployment runtime and test compatibility before adoption.
- Visual audit is not a substitute for deterministic browser checks or user-flow acceptance.

References:
- https://midscenejs.com/integrate-with-playwright
- https://midscenejs.com/model-api-setup

### 3.2 Trivy — independent security and dependency scanner

Repository: https://github.com/aquasecurity/trivy  
License: Apache-2.0.  
Verdict: **High-value complement to LampCode's existing security engine.**

Potential coverage includes dependency vulnerabilities, secrets, infrastructure misconfiguration, SBOM and licence metadata.

Proposed integration:
- Scan the shared E2B template/dependency baseline during template build or CI, not on every user build.
- Scan generated-project manifests, lockfiles and eligible infrastructure files in an isolated worker.
- Normalize Trivy findings into LampCode's existing security finding format.
- Reuse existing severity, remediation, repair and re-check behaviour where appropriate.
- Keep scanner output compact; retain full reports in build artifacts.

Important limitation: dependency coverage depends on files and package ecosystems Trivy can actually inspect. A source import list is not equivalent to a resolved lockfile. Verify which dependency manifests/lockfiles generated builds retain.

References:
- https://github.com/aquasecurity/trivy
- https://trivy.dev/latest/docs/

### 3.3 ast-grep — structural code rule engine

Repository: https://github.com/ast-grep/ast-grep  
License: MIT.  
Verdict: **Integrate selectively; do not replace existing TypeScript intelligence.**

LampCode already uses the TypeScript Compiler API in `code-intel.ts` and structural analysis in `architecture.ts`. Replacing those would duplicate capability and add migration risk.

Potential complementary uses:
- Narrow, high-confidence security/code patterns not already covered.
- Framework-specific JSX/TS patterns.
- Python backend structures where current checks are weaker.
- Targeted syntax-aware queries that are unsafe or brittle as plain regex.

Start read-only. Do not enable automatic ast-grep rewrites in production. Findings must include rule ID, path, range, evidence, confidence and proposed remediation. Existing LampCode repair logic should own changes.

Reference:
- https://github.com/ast-grep/ast-grep

### 3.4 Langfuse — execution observability

Repository: https://github.com/langfuse/langfuse  
License: MIT core; some Enterprise Edition folders have separate licensing.  
Verdict: **Later phase; optional telemetry, not a build dependency.**

LampCode already records model usage, costs, tool calls, turns, build outcomes, repair events and verification results. Langfuse could provide a connected trace view of those events and make it easier to diagnose which stage caused failures or excess cost.

Proposed integration:
- First consider exporting redacted OpenTelemetry/trace events rather than immediately self-hosting the full stack.
- Keep telemetry asynchronous and fail-open.
- Never export credentials, auth headers, private source files or sensitive user data by default.
- Do not let telemetry availability affect build success.

Constraints:
- Langfuse's current JS/TS SDK compatibility should be checked against LampCode's actual Node runtime; SDK v6 documentation indicates Node 22+.
- Self-hosting adds PostgreSQL, Redis, ClickHouse, blob storage, web and worker infrastructure. It is not a lightweight package-only addition.

References:
- https://github.com/langfuse/langfuse
- https://langfuse.com/docs
- https://langfuse.com/docs/observability/sdk/overview

### 3.5 Inspect AI — external evaluation harness

Repository: https://github.com/UKGovernmentBEIS/inspect_ai  
License: MIT.  
Verdict: **Defer; keep outside production builds for now.**

LampCode already has a real-build evaluation harness at `scripts/eval/`, with repeatable smoke/core/hard tasks, actual API builds, sandbox execution, output collection and scoring.

Inspect AI offers useful dataset, solver, scorer and evaluation concepts, but integrating a second orchestration/evaluation stack now would add maintenance without addressing a demonstrated missing production capability.

Revisit it when LampCode needs broader multi-model comparison, adversarial task evaluation or a larger standardized benchmark suite.

References:
- https://github.com/UKGovernmentBEIS/inspect_ai
- https://inspect.aisi.org.uk/

## 4. Proposed runtime architecture

Keep the existing agent and E2B application sandbox. Put specialist engines behind backend-owned verification workers:

1. **LampCode Agent** — understand, plan, generate, edit and repair.
2. **E2B application sandbox** — untrusted generated application and runtime.
3. **Independent specialist workers**:
   - Midscene: visual/UX QA.
   - Trivy: security/dependency scan.
   - ast-grep: targeted structural rules.
   - Langfuse/OTel: asynchronous observability.
4. **Verification coordinator** — normalize findings, confidence, severity, affected files and budget.
5. **Existing self-fix system** — targeted repair, then relevant regression checks.
6. **Completion audit** — evidence-based result, not the model's unsupported claim.
7. **Inspect AI** — separate offline/CI evaluation environment, if justified later.

The agent should not receive new tools for each engine. The backend should invoke them based on task type and risk, then send the model a short actionable result only when a repair is required.

## 5. Context and model-overload constraints

Current inspection found:
- `AGENTIC_BUILD_TOOLS` contains 35 static tool definitions.
- `TOOL_DEFINITIONS` contains three base definitions.
- MCP read and write definitions are capped separately by `MAX_MCP_TOOLS = 80`; this is not one combined global budget.
- Prompt construction already has configurable input/system token budgets and conditional skill loading.

Historical context in `HISTORY.md` records a real build where 283 connected tool definitions crowded out native build tools and the model failed before writing the required app file.

Recommendation: introduce task-based tool profiles and one combined tool/context budget:
- Frontend generation: core file tools, browser and verification.
- Full-stack generation: core tools plus relevant backend/database capabilities.
- Existing-project edit: surgical editing, code intelligence, impact analysis and relevant tests.
- Security repair: security finding context and affected files only.
- GitHub/deployment tasks: only relevant integration tools.

Do not attach Midscene/Trivy/ast-grep definitions to the model's tool list. Their reports should be compact and bounded.

## 6. Implementation sequence

### Phase 0 — Architecture preparation
- Map and test the current tool availability by build/task type.
- Introduce one combined budget for native and MCP tool definitions.
- Validate actual backend Node runtime and compatibility constraints.
- Define a common structured finding/report contract.
- Define a structural preservation guard for unexpected symbol/export/route loss.
- Keep the existing editing, repair, security and verification logic intact.

### Phase 1 — Midscene proof of concept
- One real generated app; use a login screen and dashboard as representative visual tasks.
- Compare existing Playwright checks with Midscene results.
- Measure true positives, false positives, repair success, added latency and separate vision-model cost.
- Do not enable automatic repair until findings are grounded and repeatable.

### Phase 2 — Trivy
- Add template dependency scanning to CI/template release.
- Test generated-project scanning against known vulnerable and safe fixtures.
- Normalize findings and feed only appropriate findings into the security repair flow.

### Phase 3 — ast-grep
- Identify a measured gap in current TS Compiler API/custom checks.
- Add only targeted structural rules.
- Keep it read-only and advisory until precision is established.

### Phase 4 — Langfuse/OTel
- Export redacted trace events asynchronously.
- Test exporter downtime, sensitive-field redaction and cost/latency overhead.
- Avoid self-hosting unless query/retention requirements justify it.

### Phase 5 — Inspect AI
- Reassess only when the current eval harness demonstrably lacks required evaluation functionality.

## 7. Final engineering verdict

| Candidate | Implementable? | Recommended role |
|---|---|---|
| Midscene | Yes, with runtime/model compatibility checks | Independent visual QA |
| Trivy | Yes | Security/dependency scanning |
| ast-grep | Yes, selectively | Structural rule engine |
| Langfuse | Yes, with runtime/infrastructure constraints | Async observability |
| Inspect AI | Yes, but not needed yet | External evaluation harness |

**Recommended first implementation: Phase 0 plus a Midscene proof of concept.** Do not add all five at once, do not replace the existing verification engine, and do not claim an integration is complete until a real build proves its value.

## Source and working rules

- Repository baseline at time of review: `bcf143954a8c98bb585b9144a4ffa6330a8c82bb`.
- `CLAUDE.md` is the source of truth; `HISTORY.md` records prior findings and measurements.
- Follow the repository's investigate-first, scoped-change, verify-and-report engineering methodology.
- This is a review and proposal only. No implementation, dependency, template or deployment change was made as part of the review.
