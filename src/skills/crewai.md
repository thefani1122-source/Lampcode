---
name: crewai
description: CrewAI multi-agent Python framework — install, Agent/Task/Crew pattern, custom tools, APScheduler scheduling, and required FastAPI/Supabase files for agent builds.
---

# CrewAI — Multi-Agent Framework (Python)

## Install
```bash
pip install crewai crewai-tools langchain-anthropic
```

## Core Pattern
```python
from crewai import Agent, Task, Crew, Process
from langchain_anthropic import ChatAnthropic
import os

llm = ChatAnthropic(model="claude-sonnet-4-6",
                    api_key=os.environ["ANTHROPIC_API_KEY"])

# Define agents with roles
researcher = Agent(
  role="[Role Name]",
  goal="[What this agent achieves]",
  backstory="[Context for behavior]",
  llm=llm,
  tools=[tool1, tool2],
  verbose=True
)

# Define tasks
task1 = Task(
  description="[Detailed instructions]",
  expected_output="[Exact output format]",
  agent=researcher
)

# Assemble crew
crew = Crew(
  agents=[researcher, writer],
  tasks=[task1, task2],
  process=Process.sequential,  # or Process.hierarchical
  verbose=True
)

result = crew.kickoff(inputs={"topic": "..."})
```

## Custom Tool
```python
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

class SearchInput(BaseModel):
  query: str = Field(description="Search query")

class ExaSearchTool(BaseTool):
  name: str = "Exa Search"
  description: str = "Search the web semantically"
  args_schema: type[BaseModel] = SearchInput

  def _run(self, query: str) -> str:
    import exa_py
    exa = exa_py.Exa(api_key=os.environ["EXA_API_KEY"])
    results = exa.search(query, num_results=5, contents=True)
    return str(results)
```

## Scheduling (APScheduler)
```python
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()
scheduler.add_job(run_crew, 'cron', hour=9, minute=0)
scheduler.start()
```

## Always generate:
- FastAPI endpoints: POST /run, GET /results, GET /status
- Supabase storage for all crew outputs
- Error handling with try/except on crew.kickoff()
- Store: { id, output, created_at, status, run_duration }
