import { readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { type AgentTaskType } from "./model-gateway.js";
interface BuildContext {
  projectId: string;
  userId: string;
  mode: "fast" | "plan";
  prompt: string;
}
import { logger } from "../server/logger.js";

// ── Token budget ──────────────────────────────────────────────────────────────

const MAX_INPUT_TOKENS = 20_000;
const CHARS_PER_TOKEN = 4; // approximation
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;

// ── Task input schema ─────────────────────────────────────────────────────────

export const taskInputSchema = z.object({
  description: z.string().min(1),
  requirements: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  outputFormat: z.enum(["prose", "json", "code", "markdown"]).default("prose"),
  targetFiles: z.array(z.string()).optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
  estimatedInputTokens: number;
}

// ── System prompts per agent type ─────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentTaskType, string> = {
  planning: `You are the BuildForge Architect. You produce comprehensive technical plans for software projects.
Analyze the requirements, break down work into phases, identify risks, and produce a structured plan.
Your output must include: architecture overview, component breakdown, data flow, API boundaries, and risk assessment.`,

  frontend: `You are an expert UI/UX designer and React developer.
Create BEAUTIFUL, POLISHED, PROFESSIONAL interfaces.
Use rich colors, gradients, proper spacing, and typography.
Use professional design standards: proper spacing, typography hierarchy, consistent colors, smooth interactions.
Prioritize visual excellence above all else.

STEP 1 — ANALYZE THE REQUEST:
Before writing any code, think about what the user ACTUALLY needs.
A 'todo app' means: add/delete/complete tasks, persistent state, clean UI, empty state, keyboard shortcuts.
A 'dashboard' means: sidebar, stats cards, charts, tables, real data.
A 'landing page' means: hero, features, pricing, testimonials, CTA, footer.
A 'timer' means: start/stop/reset, visual progress, sound feedback option.

Always build the COMPLETE version, not a skeleton:
✓ Real interactive features (not just UI shells)
✓ Realistic mock data (not 'Item 1, Item 2')
✓ Working state management (useState/useEffect)
✓ All buttons must do something
✓ Empty states must be handled
✓ Mobile responsive layout
✓ Smooth CSS transitions on interactions
✓ Proper error boundaries

STEP 2 — THEN write the code following all format rules.

Your output will be judged against Lovable, Bolt, and v0.
It must be noticeably better in: visual polish, interactivity, and completeness. No half-built features.

NEVER add watermarks, credits, or 'Designed by' text anywhere in the output.

Your code runs inside Sandpack — a fully in-browser React sandbox. It must work without a build step, a server, or a filesystem.

CRITICAL: You MUST output src/App.tsx as the VERY FIRST file, using EXACTLY this format:

\`\`\`filename:src/App.tsx
// your complete App component here
\`\`\`

Every single file must use the \`\`\`filename:path format. Never use \`\`\`tsx or \`\`\`javascript without a filename: path — those blocks will be ignored by the parser.

SANDPACK COMPATIBILITY RULES — NEVER VIOLATE THESE:

1. STYLING — ONLY these two options:
   Option A: Inline styles → style={{ color: 'white', background: '#0a0a0f' }}
   Option B: Plain CSS in src/styles.css imported as: import './styles.css'

   NEVER: import 'tailwindcss/tailwind.css'
   NEVER: @tailwind base/components/utilities
   NEVER: className="bg-blue-500 text-white" (tailwind classes won't work — no CDN)

2. PACKAGES — ONLY react and react-dom are available
   NEVER import: lucide-react, framer-motion, @radix-ui, tailwindcss,
   axios, lodash, or ANY other package
   For icons: use Unicode (▶ ✓ ✕) or inline SVG only

3. FILE ORDER — ALWAYS in this exact order:
   FIRST:  src/App.tsx (main component, export default function App)
   SECOND: src/styles.css (if needed)
   THIRD:  src/index.tsx (always same boilerplate)
   FOURTH: package.json

4. src/index.tsx ALWAYS exactly this content — do not modify it:
\`\`\`filename:src/index.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
\`\`\`

5. package.json ALWAYS exactly this content:
\`\`\`filename:package.json
{"dependencies":{"react":"^18.2.0","react-dom":"^18.2.0"}}
\`\`\`

CODE QUALITY RULES:
- Every component file must have exactly one default export
- Import useState, useEffect, and other hooks explicitly: import { useState, useEffect } from 'react'
- Use explicit TypeScript types; write \`any\` explicitly rather than omitting type annotations
- No TypeScript errors — the code must compile cleanly
- Never use server-side Node.js imports: no 'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https'

SANDPACK RESTRICTIONS — NEVER USE:
- setInterval or setTimeout with external dependencies
- window.location, document.cookie, localStorage, sessionStorage
- fetch() calls to external APIs (CORS blocked in Sandpack)
- navigator.*, screen.*, window.open()
- WebSockets or EventSource

SAFE TO USE:
- useState, useEffect with cleanup functions
- setInterval inside useEffect with return () => clearInterval(id)
- Math, Date, Array methods
- Inline SVG, canvas (basic), CSS animations

CONTENT RULES:
- Build exactly what the user describes — fully functional, not a placeholder or stub
- Handle all UI states: loading, error, empty, and populated data
- Make the UI visually complete and polished using inline styles`,

  backend: `You are the BuildForge Backend Engineer. You write robust API code with Hono.js and TypeScript.
All endpoints must: validate input with Zod, return consistent JSON, handle errors with proper status codes.
Use Drizzle ORM for database access. Never expose internal errors to clients.`,

  db: `You are the BuildForge Database Engineer. You design and write database schemas and migrations.
Use Drizzle ORM with PostgreSQL. Follow these rules: snake_case columns, explicit FK constraints,
proper index strategy, soft deletes where appropriate. Output Drizzle schema definitions and migration SQL.`,

  security: `You are the BuildForge Security Analyst. You identify vulnerabilities and harden code.
Check for: injection attacks, auth bypass, insecure defaults, sensitive data exposure, CORS misconfig.
For each finding: severity (CRITICAL/HIGH/MEDIUM/LOW), location, description, and remediation code.
Output structured JSON with a findings array.`,

  connection: `You are the BuildForge Integration Engineer. You wire together services and APIs.
Write integration code for: external APIs, webhooks, message queues, caches.
Ensure: retry logic, timeout handling, circuit breakers, proper error propagation.`,

  fix: `You are the BuildForge Bug Fixer. You diagnose and repair code issues.
Given the error and context, identify root cause and produce a minimal, correct fix.
Output: root cause explanation, the exact diff/replacement code, and test cases for the fix.`,

  deploy: `You are the BuildForge Deployment Engineer. You manage CI/CD and infrastructure.
Write: Dockerfile, GitHub Actions workflows, Kubernetes manifests, or platform config as needed.
Ensure: health checks, graceful shutdown, environment variable management, rollback strategy.`,

  monitor: `You are the BuildForge Monitoring Engineer. You set up observability.
Configure: structured logging, metrics collection, distributed tracing, alerting rules.
Output configuration files and instrumentation code for the specified stack.`,
};

// ── JSON output instruction appended for structured agents ────────────────────

const JSON_OUTPUT_AGENTS: Set<AgentTaskType> = new Set([
  "security",
  "db",
  "planning",
]);

// ── Prompt expansion ──────────────────────────────────────────────────────────

// Per-app-type feature expectations appended to short prompts so the model
// builds the COMPLETE version rather than a skeleton. Runs before the main build.
const APP_TYPE_EXPANSIONS: Array<{ match: RegExp; expansion: string }> = [
  {
    match: /\btodo|task list|task manager\b/i,
    expansion: `Build a COMPLETE task management app with ALL these features:
- Add tasks with title, priority (High/Medium/Low badge), and due date
- Priority color-coded badges: High=red, Medium=yellow/amber, Low=green
- Filter tabs: All / Active / Completed — each showing filtered count
- Sort controls: by Priority / Due Date / Created
- Task count display ("3 of 7 tasks remaining")
- 5–6 sample tasks pre-loaded with varied priorities and due dates
- Delete and toggle-complete for every task
- Empty state message when no tasks match the current filter
- Keyboard shortcut: press Enter in the input to add a task
- Clean, polished UI with smooth hover/transition effects`,
  },
  {
    match: /\bdashboard|admin panel|analytics\b/i,
    expansion: `Build a COMPLETE analytics dashboard with ALL these sections:
- Sidebar with navigation items: Dashboard, Analytics, Reports, Settings (with icons via Unicode/SVG)
- 4 KPI cards: Revenue ($84,230), Active Users (12,480), Orders (3,942), Growth (+18.4%) — each with a trend arrow (↑/↓) and a subtle sparkline or percentage change
- SVG bar or line chart (300×160 px minimum) with at least 7 realistic data points and axis labels
- Activity feed or table: 5–8 rows of realistic recent-activity data (user, action, timestamp, status badge)
- Status badges color-coded: Completed=green, Pending=yellow, Failed=red
- Professional light or dark theme with consistent spacing and typography`,
  },
  {
    match: /\blanding page|marketing site|homepage\b/i,
    expansion: "Include: a hero section, features grid, pricing tiers, testimonials, a clear CTA, and a footer.",
  },
  {
    match: /\btimer|stopwatch|pomodoro|countdown\b/i,
    expansion: "Include: start/stop/reset controls, a visual progress indicator, and clean time formatting.",
  },
  {
    match: /\bchat|messaging|messenger\b/i,
    expansion: "Include: a message list, an input box, send-on-Enter, mock conversation data, and auto-scroll to the latest message.",
  },
];

/**
 * Expand a short user prompt with completeness expectations for its app type.
 * Pure and additive — never replaces the user's intent, only appends guidance.
 * Call this BEFORE dispatching the main build so the model targets a full app.
 */
export function expandUserPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  const matched = APP_TYPE_EXPANSIONS.filter((e) => e.match.test(trimmed));
  if (matched.length === 0) return trimmed;

  const additions = matched.map((e) => `- ${e.expansion}`).join("\n");
  return `${trimmed}\n\nBuild the complete, fully-functional version:\n${additions}`;
}

// ── PromptBuilder ─────────────────────────────────────────────────────────────

export class PromptBuilder {
  private readonly contractsDir: string;

  constructor(contractsDir: string = process.cwd()) {
    this.contractsDir = contractsDir;
  }

  async build(
    agentType: AgentTaskType,
    task: TaskInput,
    context: BuildContext,
    workspaceDir?: string | undefined,
    contextFiles?: Array<{ path: string; content: string }> | undefined,
  ): Promise<BuiltPrompt> {
    const systemPrompt = this.buildSystemPrompt(agentType, task.outputFormat);
    const contextBlock = await this.buildContextBlock(agentType, workspaceDir, contextFiles);
    const taskBlock = this.buildTaskBlock(task, context);

    const userMessage = this.truncate(
      [contextBlock, taskBlock].filter((s) => s.length > 0).join("\n\n"),
      MAX_INPUT_CHARS - systemPrompt.length,
    );

    const estimatedInputTokens =
      Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) +
      Math.ceil(userMessage.length / CHARS_PER_TOKEN);

    logger.debug(
      { agentType, estimatedInputTokens },
      "Prompt built",
    );

    return { systemPrompt, userMessage, estimatedInputTokens };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private buildSystemPrompt(agentType: AgentTaskType, outputFormat: TaskInput["outputFormat"]): string {
    const base = SYSTEM_PROMPTS[agentType];
    const jsonInstruction =
      JSON_OUTPUT_AGENTS.has(agentType) || outputFormat === "json"
        ? "\n\nRESPONSE FORMAT: Output valid JSON only. No prose outside the JSON structure."
        : "";
    return base + jsonInstruction;
  }

  private async buildContextBlock(
    agentType: AgentTaskType,
    workspaceDir?: string | undefined,
    contextFiles?: Array<{ path: string; content: string }> | undefined,
  ): Promise<string> {
    const files = this.relevantFiles(agentType);
    const sections: string[] = [];

    // Pre-selected context files from ContextManager (injected before standard brain files)
    if (contextFiles !== undefined && contextFiles.length > 0) {
      const seenPaths = new Set(contextFiles.map((f) => f.path));
      for (const { path, content } of contextFiles) {
        sections.push(`## ${path}\n${content}`);
      }
      // Exclude already-included brain files from the standard block
      const remainingBrainFiles = files.filter((name) => !seenPaths.has(name));
      for (const filename of remainingBrainFiles) {
        const dirs = workspaceDir !== undefined ? [workspaceDir, this.contractsDir] : [this.contractsDir];
        let content: string | null = null;
        for (const dir of dirs) {
          content = await this.readFileFrom(dir, filename);
          if (content !== null) break;
        }
        if (content !== null) sections.push(`## ${filename}\n${content}`);
      }
      return sections.join("\n\n");
    }

    // Read from workspace dir first (project-specific brain files), fallback to contractsDir
    const dirs = workspaceDir !== undefined ? [workspaceDir, this.contractsDir] : [this.contractsDir];
    const seen = new Set<string>();

    for (const filename of files) {
      if (seen.has(filename)) continue;
      seen.add(filename);
      let content: string | null = null;
      for (const dir of dirs) {
        content = await this.readFileFrom(dir, filename);
        if (content !== null) break;
      }
      if (content !== null) {
        sections.push(`## ${filename}\n${content}`);
      }
    }

    return sections.join("\n\n");
  }

  private buildTaskBlock(task: TaskInput, context: BuildContext): string {
    const parts = [
      `## Task`,
      task.description,
    ];

    if (task.requirements !== undefined && task.requirements.length > 0) {
      parts.push("## Requirements", task.requirements.map((r) => `- ${r}`).join("\n"));
    }

    if (task.constraints !== undefined && task.constraints.length > 0) {
      parts.push("## Constraints", task.constraints.map((c) => `- ${c}`).join("\n"));
    }

    if (task.targetFiles !== undefined && task.targetFiles.length > 0) {
      parts.push("## Target Files", task.targetFiles.join(", "));
    }

    parts.push(
      "## Project Context",
      `- Project ID: ${context.projectId}`,
      `- Build mode: ${context.mode}`,
      `- User prompt: ${context.prompt}`,
    );

    return parts.join("\n\n");
  }

  private relevantFiles(agentType: AgentTaskType): string[] {
    const byType: Record<AgentTaskType, string[]> = {
      planning:   ["CONTRACT.md", "DB_SCHEMA.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      frontend:   ["CONTRACT.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      backend:    ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      db:         ["CONTRACT.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      security:   ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md", "CURRENT_STATE.md"],
      connection: ["CONTRACT.md", "API_CONTRACTS.md", "CURRENT_STATE.md"],
      fix:        ["CONTRACT.md", "CURRENT_STATE.md"],
      deploy:     ["CONTRACT.md", "CURRENT_STATE.md"],
      monitor:    ["CONTRACT.md", "CURRENT_STATE.md"],
    };
    return [...new Set(byType[agentType] ?? ["CONTRACT.md"])];
  }

  private async readFileFrom(dir: string, filename: string): Promise<string | null> {
    const filepath = join(dir, filename);
    try {
      const content = await readFile(filepath, "utf8");
      return content.trim();
    } catch {
      return null;
    }
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    // Trim to the last complete line to avoid mid-sentence cuts
    const lastNewline = truncated.lastIndexOf("\n");
    return (lastNewline > maxChars * 0.8 ? truncated.slice(0, lastNewline) : truncated) +
      "\n\n[Context truncated to fit token budget]";
  }
}
