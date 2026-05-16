import { readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { type AgentTaskType } from "./model-gateway.js";
import { type BuildContext } from "../orchestrator/engine.js";
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

  frontend: `You are the BuildForge Frontend Engineer. You write modern, accessible UI code.
Use React with TypeScript. Prefer Tailwind CSS. Components must be typed, tested, and responsive.
Output complete, production-ready component files. Never use 'any'. Always handle loading and error states.`,

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
  ): Promise<BuiltPrompt> {
    const systemPrompt = this.buildSystemPrompt(agentType, task.outputFormat);
    const contextBlock = await this.buildContextBlock(agentType);
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

  private async buildContextBlock(agentType: AgentTaskType): Promise<string> {
    const files = this.relevantFiles(agentType);
    const sections: string[] = [];

    for (const filename of files) {
      const content = await this.readContractFile(filename);
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
    const always = ["CONTRACT.md"];
    const byType: Record<AgentTaskType, string[]> = {
      planning:   ["CONTRACT.md", "DB_SCHEMA.md", "API_CONTRACTS.md"],
      frontend:   ["CONTRACT.md", "API_CONTRACTS.md"],
      backend:    ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md"],
      db:         ["CONTRACT.md", "DB_SCHEMA.md"],
      security:   ["CONTRACT.md", "API_CONTRACTS.md", "DB_SCHEMA.md"],
      connection: ["CONTRACT.md", "API_CONTRACTS.md"],
      fix:        ["CONTRACT.md"],
      deploy:     ["CONTRACT.md"],
      monitor:    ["CONTRACT.md"],
    };
    return [...new Set([...always, ...(byType[agentType] ?? [])])];
  }

  private async readContractFile(filename: string): Promise<string | null> {
    const filepath = join(this.contractsDir, filename);
    try {
      const content = await readFile(filepath, "utf8");
      return content.trim();
    } catch {
      // File doesn't exist yet — skip silently
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
