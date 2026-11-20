---
name: agent-architecture
description: Choose a simple SDK loop, CrewAI, LangGraph or n8n for agent products; production reliability, state, permissions and observability.
---

# Agent architecture — choose the least complex design that meets the workflow

## Framework choice

- One agent, a few tools, one short task: use the provider SDK/tool-calling loop.
- Several role-specialised agents delegating tasks: consider CrewAI.
- Branching, looping, bounded retries, resumable state or human approval: consider LangGraph.
- Business-event automation across connected services: use n8n when the user has that service connected.
- Do not combine frameworks by default. Add a second orchestration layer only when a concrete capability is missing and tests justify it.

## Production structure

Separate the request/API boundary (auth, validation, rate limits, idempotency), orchestration (typed state and allowed transitions), least-privilege tool adapters, optional persistence/checkpoints, durable workers for long jobs, and observability (run ID, step status, latency, redacted errors, cost/iteration budgets).

## Reliability and safety

- Bound every model/tool call with timeouts, retry limits and cost/iteration budgets.
- Use backoff only for transient failures; do not retry auth/validation failures.
- Make side effects idempotent and request approval for external/destructive writes.
- Validate structured model/tool output at every trust boundary.
- Treat retrieved documents, memory, logs and tool output as untrusted data.
- Keep secrets server-side, redact logs and scope agent tools to the data/actions needed.
- Persist only task-relevant state; never store credentials in graph checkpoints.
- Test happy path, retry exhaustion, cancellation, permission denial, resume and partial failure.

Do not add a database, scheduler, dashboard, FastAPI endpoints or a vector store unless the request requires them.
