import { config } from "../config.js";
import { logger } from "../logger.js";
import type { InterviewSession, SecurityContract, TaskItem, TaskAgentType } from "../types/interview.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MODEL = "anthropic/claude-opus-4-6";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;

// ── OpenRouter raw call ───────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callOpenRouter(
  messages: ChatMessage[],
  attempt = 0,
): Promise<string> {
  const apiKey = config.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://lampcode.dev",
        "X-Title": "Lampcode Planning Agent",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 4_096,
        temperature: 0.3,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Empty response from OpenRouter");
    return content;
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const label = isAbort ? "timeout" : String(err);

    logger.warn({ attempt, model: MODEL, err: label }, "Planning agent call failed");

    if (attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 1_000;
      await new Promise((r) => setTimeout(r, delay));
      return callOpenRouter(messages, attempt + 1);
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON extraction from LLM response ────────────────────────────────────────

function extractJson(text: string): unknown {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const start = clean.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in response");
  const end = Math.max(clean.lastIndexOf("}"), clean.lastIndexOf("]"));
  return JSON.parse(clean.slice(start, end + 1));
}

// ── Contract generation ───────────────────────────────────────────────────────

const CONTRACT_SYSTEM_PROMPT = `You are a Planning Agent for Lampcode, an AI-powered app builder.
Generate a PROJECT_SECURITY_CONTRACT based on interview answers.
Return ONLY valid JSON with this exact structure (no markdown, no prose):
{
  "appType": "string describing app type",
  "userRoles": ["role1", "role2"],
  "dataIsolation": "string describing data isolation strategy",
  "payments": "string describing payment setup",
  "sensitiveData": "string describing sensitive data handling",
  "scale": "string describing expected scale",
  "integrations": ["integration1", "integration2"],
  "mandatoryChecks": [
    "specific security check 1",
    "specific security check 2"
  ]
}
Include at least 5 mandatory security checks relevant to the app type.`;

function buildContractPrompt(session: InterviewSession): string {
  const lines = [
    `Project description: ${session.initialPrompt}`,
    "",
    "Interview answers:",
  ];
  for (const answer of session.answers) {
    const value = answer.customInput ? `${answer.selectedOption} (custom: ${answer.customInput})` : answer.selectedOption;
    lines.push(`  Q${answer.questionId}: ${value}`);
  }
  return lines.join("\n");
}

export async function generateContract(
  session: InterviewSession,
): Promise<SecurityContract> {
  const prompt = buildContractPrompt(session);
  try {
    const raw = await callOpenRouter([
      { role: "system", content: CONTRACT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
    const parsed = extractJson(raw) as Record<string, unknown>;

    return {
      appType: String(parsed["appType"] ?? "Custom Application"),
      userRoles: Array.isArray(parsed["userRoles"])
        ? (parsed["userRoles"] as string[])
        : ["User"],
      dataIsolation: String(parsed["dataIsolation"] ?? "Private"),
      payments: String(parsed["payments"] ?? "None"),
      sensitiveData: String(parsed["sensitiveData"] ?? "Basic Personal"),
      scale: String(parsed["scale"] ?? "Personal/MVP"),
      integrations: Array.isArray(parsed["integrations"])
        ? (parsed["integrations"] as string[])
        : [],
      mandatoryChecks: Array.isArray(parsed["mandatoryChecks"])
        ? (parsed["mandatoryChecks"] as string[])
        : fallbackChecks(session),
    };
  } catch (err) {
    logger.warn({ sessionId: session.id, err }, "Contract generation failed — using fallback");
    return fallbackContract(session);
  }
}

// ── Task division ─────────────────────────────────────────────────────────────

const TASKS_SYSTEM_PROMPT = `You are a Planning Agent for Lampcode.
Divide this project into concrete development tasks.
Rules:
- Each task max 20 minutes of estimated work
- Specify agent: "frontend" | "backend" | "database" | "security" | "deploy"
- List dependency task IDs (empty array if none)
- Be specific, actionable, and granular
Return ONLY a JSON array with this structure:
[
  {
    "id": "t1",
    "agent": "database",
    "description": "Create users table with email, password_hash, role columns",
    "estimatedMinutes": 10,
    "dependencies": []
  }
]`;

function buildTasksPrompt(session: InterviewSession): string {
  if (!session.contract) throw new Error("Contract must be generated before dividing tasks");
  return [
    `Project: ${session.initialPrompt}`,
    "",
    `App type: ${session.contract.appType}`,
    `User roles: ${session.contract.userRoles.join(", ")}`,
    `Data isolation: ${session.contract.dataIsolation}`,
    `Payments: ${session.contract.payments}`,
    `Sensitive data: ${session.contract.sensitiveData}`,
    `Scale: ${session.contract.scale}`,
    `Integrations: ${session.contract.integrations.join(", ") || "none"}`,
    "",
    "Security requirements:",
    ...session.contract.mandatoryChecks.map((c) => `  - ${c}`),
  ].join("\n");
}

const VALID_AGENTS = new Set<TaskAgentType>(["frontend", "backend", "database", "security", "deploy"]);

export async function divideTasks(session: InterviewSession): Promise<TaskItem[]> {
  const prompt = buildTasksPrompt(session);
  try {
    const raw = await callOpenRouter([
      { role: "system", content: TASKS_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);

    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) throw new Error("Tasks response is not an array");

    return (parsed as Array<Record<string, unknown>>).map((item, idx) => {
      const agent = String(item["agent"] ?? "backend") as TaskAgentType;
      return {
        id: String(item["id"] ?? `t${idx + 1}`),
        agent: VALID_AGENTS.has(agent) ? agent : "backend",
        description: String(item["description"] ?? "Task"),
        estimatedMinutes: Math.min(Number(item["estimatedMinutes"] ?? 15), 20),
        dependencies: Array.isArray(item["dependencies"])
          ? (item["dependencies"] as string[])
          : [],
        status: "pending" as const,
      };
    });
  } catch (err) {
    logger.warn({ sessionId: session.id, err }, "Task division failed — using fallback");
    return fallbackTasks(session.contract);
  }
}

// ── Fallbacks ─────────────────────────────────────────────────────────────────

function fallbackChecks(session: InterviewSession): string[] {
  const checks = [
    "Input validation and sanitization on all endpoints",
    "JWT authentication required for all protected routes",
    "Rate limiting on public API endpoints (100 req/min)",
    "HTTPS-only — no HTTP fallback",
    "Secrets stored in environment variables, never in code",
  ];

  const answers = Object.fromEntries(
    session.answers.map((a) => [a.questionId, a.selectedOption]),
  );

  if (answers["q4"] && answers["q4"] !== "Nahi (free app)") {
    checks.push("PCI-DSS compliance — use Stripe.js, never store raw card data");
  }
  if (answers["q5"] && !answers["q5"].startsWith("Nahi")) {
    checks.push("Encrypt sensitive fields at rest (AES-256)");
    checks.push("GDPR compliance — data export and deletion endpoints required");
  }
  if (answers["q2"] && answers["q2"].includes("Role")) {
    checks.push("Role-based access control (RBAC) enforced at middleware layer");
  }

  return checks;
}

function fallbackContract(session: InterviewSession): SecurityContract {
  const answers = Object.fromEntries(
    session.answers.map((a) => [a.questionId, a.customInput ?? a.selectedOption]),
  );
  return {
    appType: answers["q1"] ?? "Custom Application",
    userRoles: [answers["q2"] ?? "User"],
    dataIsolation: answers["q3"] ?? "Private",
    payments: answers["q4"] ?? "None",
    sensitiveData: answers["q5"] ?? "Basic Personal",
    scale: answers["q6"] ?? "Personal/MVP",
    integrations: answers["q7"] && answers["q7"] !== "Koi nahi" ? [answers["q7"]] : [],
    mandatoryChecks: fallbackChecks(session),
  };
}

function fallbackTasks(contract: SecurityContract | undefined): TaskItem[] {
  const hasPay = contract?.payments !== "None" && contract?.payments !== "Nahi (free app)";
  const hasRoles = (contract?.userRoles.length ?? 0) > 1;

  const tasks: TaskItem[] = [
    { id: "t1", agent: "database", description: "Design and create core database schema (users, sessions tables)", estimatedMinutes: 15, dependencies: [], status: "pending" },
    { id: "t2", agent: "backend",  description: "Set up Hono.js server with auth middleware and CORS config", estimatedMinutes: 15, dependencies: ["t1"], status: "pending" },
    { id: "t3", agent: "backend",  description: "Implement user registration and login endpoints", estimatedMinutes: 20, dependencies: ["t2"], status: "pending" },
    { id: "t4", agent: "frontend", description: "Build authentication pages (login, register, forgot password)", estimatedMinutes: 20, dependencies: ["t3"], status: "pending" },
    { id: "t5", agent: "frontend", description: "Build main application layout and navigation", estimatedMinutes: 15, dependencies: ["t4"], status: "pending" },
    { id: "t6", agent: "backend",  description: "Implement core business logic CRUD endpoints", estimatedMinutes: 20, dependencies: ["t3"], status: "pending" },
    { id: "t7", agent: "frontend", description: "Build core feature UI components", estimatedMinutes: 20, dependencies: ["t5", "t6"], status: "pending" },
    { id: "t8", agent: "security", description: "Audit all endpoints for auth, RBAC, and input validation", estimatedMinutes: 20, dependencies: ["t6"], status: "pending" },
    { id: "t9", agent: "deploy",   description: "Configure Dockerfile and Railway deployment config", estimatedMinutes: 10, dependencies: ["t8"], status: "pending" },
  ];

  if (hasRoles) {
    tasks.splice(3, 0, {
      id: "t2b", agent: "backend", description: "Implement role-based access control middleware", estimatedMinutes: 15, dependencies: ["t2"], status: "pending",
    });
  }
  if (hasPay) {
    tasks.push({
      id: "t10", agent: "backend", description: "Integrate Stripe for payment processing", estimatedMinutes: 20, dependencies: ["t6"], status: "pending",
    });
  }

  return tasks;
}
