# Lampcode Pipeline — Gap Analysis vs Production Architecture Briefs

Compared our **actual current pipeline** (code-verified) against the two shared
architecture docs:
- **Doc A** — pragmatic AI app-builder blueprint (E2B + sidecar + tool-calls + fixer loop)
- **Doc B** — "VibeCode" 10-layer enterprise brief (Rust Conductor, Firecracker, Temporal, Yjs, Neo4j…)

> **Important framing:** Doc B is a 90-day / 10K-DAU enterprise build (Rust, Temporal,
> self-hosted vLLM, Firecracker, Neo4j, Yjs CRDT). **Do NOT chase that stack** — it would
> bury us for months and most of it is premature. Doc A is the right north star for us; it
> even lists "what to skip on v1". The gaps below are where **Doc A's load-bearing pieces**
> are missing from our pipeline — these are what actually make fullstack apps reliable.

Doc A's explicit "must build on day one" list: **streaming tool-call parser, sandbox
sidecar, patch engine with git-commit-per-turn, fixer loop with fingerprint dedup, token
budgeter.** We have: token budgeter (partial). The rest are missing or weak.

---

## TOP 3 — these are why apps feel unreliable (fix first)

### G1. No validation + auto-fix loop  ⭐ highest impact
- **Now:** After a build we never run `tsc`, `eslint`, or `vite build`. No browser/runtime
  error capture. The only "fix" is: re-dispatch once if output is empty or a fullstack file
  is missing. No attempt counter, no error fingerprint.
- **Doc A §7 / Doc B L3:** "The fix loop is where 80% of perceived quality lives." Validate →
  collect typed errors → re-prompt a Fixer agent (changed files + stack frames only) → max 3
  attempts → **error-fingerprint dedup** to kill the "fix A breaks B, fix B breaks A" loop.
- **Why it bit us:** the `allowedHosts` preview break would have been caught + auto-fixed if we
  ran the preview and fed the error back. Instead the user hit it manually.
- **Fix:** In the E2B sandbox after `writeFiles`, run `npx tsc --noEmit` (and capture Vite
  stderr). Parse errors into `{file,line,col,msg}`. If non-empty → child "fix turn" to the
  fix agent with only the failing files + errors. Counter max 3, fingerprint = hash(type+top
  stack frame+file); abort+escalate on repeat. **Effort: Large** (but biggest quality win).

### G2. Scaffold generated from scratch every turn (not a template)
- **Now:** `vite.config.ts`, `package.json`, TS/Tailwind config are LLM-generated each build
  from prose rules in the system prompt (`FRAMEWORK_RULES`). This is *exactly* what produced
  the `allowedHosts` bug, the double-Vite risk, and stray `BEGIN_EDIT` markers.
- **Doc A §1.5:** "Scaffolding is a **template repo cloned**, not LLM-generated. Generating
  Vite+Tailwind+TS from scratch every turn is wasted tokens and a reliable source of breakage."
- **Fix:** We already built the `lampcode-vite` E2B template. Bake a known-good baseline
  scaffold (correct `vite.config.ts` with `allowedHosts`, `package.json`, `tsconfig`, `index.html`)
  INTO that template. The LLM then only writes `src/**` app files on top — never config files.
  Stop emitting config files from the model entirely. **Effort: Medium.** (Removes a whole class
  of bugs; the G-patch we just shipped becomes a belt-and-suspenders backup.)

### G3. DB is manual — preview can't actually run fullstack
- **Now:** We emit `schema.sql` + `types.ts` as **artifacts** and tell the user to go create a
  Supabase project, paste SQL, fill `.env`, and deploy themselves. The E2B preview has no real
  database, so a "todo app with login" preview can never truly work end-to-end.
- **Doc A §5.2:** Provision **Postgres-per-project** (Neon branch, ~1s, scale-to-zero), apply
  migrations **transactionally** in the sandbox, drift-check, destructive-migration approval.
- **Fix:** Add a per-project Neon (or Supabase) branch provisioned at first fullstack build;
  inject its connection string into the sandbox env; run the generated migration in a
  transaction inside the VM. This is the single biggest "fullstack apps are hard to manage"
  unlock. **Effort: Large.** (Can phase: start with auto-provisioning + transactional apply,
  add drift/approval later.)

---

## NEXT TIER — reliability + UX (after top 3)

### G4. Markdown fences instead of structured tool calls
- **Now:** Model emits ```` ```filename:path ```` fences; we regex-parse them (a ~130-line
  tarpit in `file-parser.ts`) — plus a custom `BEGIN_EDIT/END_EDIT` surgical-edit dialect that
  leaks markers and mis-anchors.
- **Doc A §1.3:** Use provider **tool calls** (`write_file`, `edit_file({search,replace})`,
  `run_command`, `create_migration`). Streamable, validatable, no fence ambiguity. Our gateway
  already understands `tool_call` chunks — the model is just never asked to use them.
- **Fix:** Define the tool schema, switch the prompt to tool-calling, parse `tool_call` events
  instead of fences. Replace `BEGIN_EDIT` with real `edit_file({search,replace})` validated at
  apply time (retry on `EDIT_NOT_FOUND`). **Effort: Large, high-leverage** (kills a recurring
  bug class; do after G1/G2 since it touches everything).

### G5. No git-commit-per-turn (no real revert)
- **Now:** State = files copied between `outputDir`s + DB rows. No history, no atomic revert.
- **Doc A §1.5:** One `git commit` per turn inside the sandbox; revert = `git reset --hard
  {turn-1}`. Git is the time machine.
- **Fix:** `git init` the project dir in the sandbox; commit after each successful turn with
  `turn:{id} {summary}`; expose revert. **Effort: Medium.**

### G6. No conversation memory / rolling summary
- **Now:** Every build is a fresh prompt — zero history. Only lexical keyword "smart selection"
  picks 1–2 files; no embeddings, no import-graph.
- **Doc A §3:** Last 2 turns verbatim + LLM rolling summary (every ~5 turns), strip tool
  outputs, hybrid retrieval (ripgrep + import-graph; embeddings later).
- **Fix:** Add a `turns` history with rolling summary in the prompt; add a ripgrep + 1-hop
  import-graph retrieval pass before generation. **Effort: Medium** (start with summary +
  ripgrep; skip embeddings for now).

### G7. No browser/runtime error capture from the preview
- **Now:** Zero. No `window.onerror`, `unhandledrejection`, or React error-boundary capture
  from the preview iframe; one-way WS only.
- **Doc A §2.6:** Inject a tiny script into the preview that posts `onerror` /
  `unhandledrejection` / boundary errors back to the parent → control plane → feeds G1's fixer.
- **Fix:** Inject error-capture script into the preview HTML; bridge via `postMessage` →
  WS → fixer loop. **Effort: Medium** (pairs with G1).

---

## QUICK WINS — cheap, do anytime

### G8. WS event contract mismatch (our own existing bug)
- Backend failure/cancel paths emit `build_failed` (underscore) but the frontend only listens
  for `build:error` / `build:cancelled` (colon). On a failed build the user sees a hang, not an
  error. **Fix:** emit the colon events the client listens for. **Effort: Small.**

### G9. No idempotency key on turn start
- A flaky-network retry can double-generate / double-charge. **Doc A §1.1.** **Fix:** accept an
  idempotency key on build start, dedupe in Redis. **Effort: Small.**

### G10. Secrets written to disk in sandbox
- We write `.env` into the sandbox. **Doc A §5.4 / Doc B L10:** runtime secrets injected into
  process env via sidecar, never on disk; redact secrets before sending file context to the LLM.
- **Fix:** inject runtime env vars via `commands.run({ envs })`, keep them out of written files;
  add a gitleaks-style redaction pass on context sent to the model. **Effort: Medium**, defer.

---

## What we do NOT need (avoid the trap)
From Doc B, explicitly **skip**: Rust Conductor, self-hosted vLLM/DeepSeek, Firecracker-custom
(E2B already gives us Firecracker), Temporal, Neo4j, Qdrant, Yjs CRDT collaboration, LoRA
personalization, multi-region SOC2. All premature for our stage. Our OpenRouter + E2B +
Supabase + Socket.IO stack is fine — the gaps above are about *pipeline correctness*, not infra.

---

## Suggested order
1. **G2** (template scaffold) + **G8** (WS events) — stops active bleeding, small/medium.
2. **G1** + **G7** (validate + capture + fixer loop) — the big quality unlock.
3. **G3** (real per-project DB) — makes fullstack previews actually work.
4. **G4** (tool calls), **G5** (git), **G6** (memory) — structural hardening.
5. **G9**, **G10** — when convenient.
