# LangGraph — Stateful Agent Workflows (Python)

## Install
```bash
pip install langgraph langchain-anthropic
```

## When to use LangGraph instead of CrewAI:
- Agent needs to loop/retry based on output quality
- Human-in-the-loop approval needed
- Complex branching logic (if output X → do Y, else Z)
- Agent needs persistent memory across runs
- You need checkpointing (resume after failure)

## Core Pattern
```python
from langgraph.graph import StateGraph, END
from langchain_anthropic import ChatAnthropic
from typing import TypedDict

class AgentState(TypedDict):
  messages: list
  research_output: str
  final_output: str

def research_node(state: AgentState):
  # Do research
  return {"research_output": result}

def write_node(state: AgentState):
  # Generate content using research_output
  return {"final_output": result}

def should_continue(state: AgentState):
  # Conditional routing
  if quality_check(state["final_output"]):
    return END
  return "write_node"  # retry

workflow = StateGraph(AgentState)
workflow.add_node("research", research_node)
workflow.add_node("write", write_node)
workflow.add_edge("research", "write")
workflow.add_conditional_edges("write", should_continue)
workflow.set_entry_point("research")

app = workflow.compile()
result = app.invoke({"messages": [], "research_output": "",
                     "final_output": ""})
```
