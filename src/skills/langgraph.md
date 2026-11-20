---
name: langgraph
description: LangGraph stateful workflows — branching, bounded loops/retries, human approval and checkpoints for long-running agents.
---

# LangGraph — stateful agent workflows

Choose LangGraph when an agent needs explicit graph state, branching, conditional loops, retry/resume or checkpointed human approval. Use a direct model SDK for a straightforward one-agent tool loop. Use CrewAI for a role-based team when delegation is the core abstraction; do not install both unless the product needs both.

## Install only for this project

Add langgraph and only the LangChain integrations actually used to requirements.txt. LampCode installs them into the isolated Python project venv before the backend starts; they are not baked into every sandbox.

## Design requirements

- Define a typed state schema and keep only information required by later nodes.
- Make graph transitions explicit; every cycle must have a bounded condition or iteration limit.
- Use durable checkpoint storage for workflows that must survive process restarts. In-memory checkpointers are development-only.
- Add timeouts, bounded retries with backoff, idempotency and cancellation for external operations.
- Human approval must interrupt before privileged writes, then resume with an auditable decision.
- Keep credentials in server-side environment variables; never serialize secrets into checkpoint state.
- Validate model/tool output against schemas at every trust boundary.
