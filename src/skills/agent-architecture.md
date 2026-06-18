# When to Use Which Framework

## Decision Tree:
```
Simple task (1 agent, no pipeline)
  → Use Anthropic SDK directly (no framework)

Multi-step pipeline (Research → Analyze → Write)
  → Use CrewAI (simplest, most readable)

Complex with branching/retry/memory
  → Use LangGraph

Visual automation (trigger, transform, notify)
  → Use n8n workflow (if user has n8n connected)
```

## Always include in agent builds:
- FastAPI: POST /run, GET /results, GET /status
- APScheduler for time-based triggers
- Supabase: store every run output with timestamp
- React dashboard: show results, manual run button
- Environment variables: never hardcode API keys

## Code quality for agent builds:
- Type hints on every function
- try/except on every LLM call
- Log errors to Supabase with full traceback
- Timeout handling (agents can hang)
- Result validation before storing
