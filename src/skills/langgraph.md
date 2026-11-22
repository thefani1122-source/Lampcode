---
name: langgraph
description: LangGraph stateful workflows — branching, bounded loops/retries, human approval and checkpoints for long-running agents.
---

# LangGraph — stateful agent workflows

Choose LangGraph when an agent needs explicit graph state, branching, conditional loops, retry/resume or checkpointed human approval. Use a direct model SDK for a straightforward one-agent tool loop. Use CrewAI for a role-based team when delegation is the core abstraction; do not install both unless the product needs both.

## Install only for this project

LangGraph is intentionally **not baked into every Ubuntu image**. The shared runtime includes Python 3.12 and the base FastAPI/Uvicorn/Supabase packages; each `projectId` has its own isolated E2B sandbox.

When the generated app actually needs LangGraph, add `langgraph` and only the LangChain integrations used, with pinned, reviewed PyPI versions in `requirements.txt`. The current runtime does **not** auto-install Python requirements. Install them in this project's sandbox using the `shell` tool and the explicit approval flow:

```bash
/opt/lampcode-python/bin/python3 -m pip install -r requirements.txt
```

Do not use system `pip`, `sudo pip`, remote/VCS URLs, editable installs, local paths or extra package indexes. Keep the dependency list minimal. The shell approval is intentional: Python packages execute third-party code. The same sandbox venv is used when LampCode starts the project's FastAPI backend.

## Design requirements

- Define a typed state schema and keep only information required by later nodes.
- Make graph transitions explicit; every cycle must have a bounded condition or iteration limit.
- Use durable checkpoint storage for workflows that must survive process restarts. In-memory checkpointers are development-only.
- Add timeouts, bounded retries with backoff, idempotency and cancellation for external operations.
- Human approval must interrupt before privileged writes, then resume with an auditable decision.
- Keep credentials in server-side environment variables; never serialize secrets into checkpoint state.
- Validate model/tool output against schemas at every trust boundary.
