import { createRedis } from "../../lib/redis.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { INTERVIEW_QUESTIONS, TOTAL_QUESTIONS } from "../data/interview-questions.js";
import { generateContract, divideTasks } from "./planning-agent.js";
import type {
  InterviewSession,
  InterviewAnswer,
  InterviewQuestion,
  SecurityContract,
  TaskItem,
} from "../types/interview.js";

// ── Redis client (lazy) ───────────────────────────────────────────────────────

import { type Redis } from "ioredis";

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis !== null) return _redis;
  _redis = createRedis({ maxRetriesPerRequest: 3 });
  _redis.on("error", (err) => logger.warn({ err }, "Interview Redis error"));
  return _redis;
}

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY = (sessionId: string) => `interview:${sessionId}`;
const TTL_SECONDS = 60 * 60 * 24; // 24 hours

// ── Serialise / deserialise session ──────────────────────────────────────────

type RedisHash = Record<string, string>;

function serialise(session: InterviewSession): RedisHash {
  return {
    id: session.id,
    projectId: session.projectId,
    userId: session.userId,
    initialPrompt: session.initialPrompt,
    currentQuestionIndex: String(session.currentQuestionIndex),
    answers: JSON.stringify(session.answers),
    status: session.status,
    contract: session.contract !== undefined ? JSON.stringify(session.contract) : "",
    tasks: session.tasks !== undefined ? JSON.stringify(session.tasks) : "",
    totalEstimatedMinutes:
      session.totalEstimatedMinutes !== undefined
        ? String(session.totalEstimatedMinutes)
        : "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function deserialise(hash: RedisHash): InterviewSession {
  return {
    id: hash["id"] ?? "",
    projectId: hash["projectId"] ?? "",
    userId: hash["userId"] ?? "",
    initialPrompt: hash["initialPrompt"] ?? "",
    currentQuestionIndex: parseInt(hash["currentQuestionIndex"] ?? "0", 10),
    answers: hash["answers"] ? (JSON.parse(hash["answers"]) as InterviewAnswer[]) : [],
    status: (hash["status"] as InterviewSession["status"]) ?? "in_progress",
    contract: hash["contract"] ? (JSON.parse(hash["contract"]) as SecurityContract) : undefined,
    tasks: hash["tasks"] ? (JSON.parse(hash["tasks"]) as TaskItem[]) : undefined,
    totalEstimatedMinutes: hash["totalEstimatedMinutes"]
      ? parseInt(hash["totalEstimatedMinutes"], 10)
      : undefined,
    createdAt: hash["createdAt"] ?? new Date().toISOString(),
    updatedAt: hash["updatedAt"] ?? new Date().toISOString(),
  };
}

async function saveSession(session: InterviewSession): Promise<void> {
  const redis = getRedis();
  const key = KEY(session.id);
  await redis.hset(key, serialise(session));
  await redis.expire(key, TTL_SECONDS);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createSession(
  projectId: string,
  userId: string,
  initialPrompt: string,
): Promise<{ session: InterviewSession; firstQuestion: InterviewQuestion }> {
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const session: InterviewSession = {
    id: sessionId,
    projectId,
    userId,
    initialPrompt,
    currentQuestionIndex: 0,
    answers: [],
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  };

  await saveSession(session);
  logger.info({ sessionId, projectId }, "Interview session created");

  const firstQuestion = INTERVIEW_QUESTIONS[0];
  if (!firstQuestion) throw new Error("No interview questions configured");

  return { session, firstQuestion };
}

export async function getSession(sessionId: string): Promise<InterviewSession | null> {
  const redis = getRedis();
  const hash = await redis.hgetall(KEY(sessionId));
  if (!hash || Object.keys(hash).length === 0) return null;
  return deserialise(hash as RedisHash);
}

export interface SubmitAnswerResult {
  nextQuestion: InterviewQuestion | null;
  progress: string;
  isComplete: boolean;
  contract?: SecurityContract;
  tasks?: TaskItem[];
  totalEstimatedMinutes?: number;
}

export async function submitAnswer(
  sessionId: string,
  answer: InterviewAnswer,
): Promise<SubmitAnswerResult> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Interview session not found: ${sessionId}`);
  if (session.status !== "in_progress") {
    throw new Error(`Session is in status '${session.status}', expected 'in_progress'`);
  }

  // Record answer
  const answers = [...session.answers, answer];
  const nextIndex = session.currentQuestionIndex + 1;

  if (nextIndex < TOTAL_QUESTIONS) {
    // More questions remain
    const updated: InterviewSession = {
      ...session,
      answers,
      currentQuestionIndex: nextIndex,
      updatedAt: new Date().toISOString(),
    };
    await saveSession(updated);

    const nextQuestion = INTERVIEW_QUESTIONS[nextIndex];
    if (!nextQuestion) throw new Error(`No question at index ${nextIndex}`);

    return {
      nextQuestion,
      progress: `${nextIndex + 1}/${TOTAL_QUESTIONS}`,
      isComplete: false,
    };
  }

  // Last question answered — generate contract + tasks
  const withAnswers: InterviewSession = {
    ...session,
    answers,
    currentQuestionIndex: nextIndex,
    status: "generating_contract",
    updatedAt: new Date().toISOString(),
  };
  await saveSession(withAnswers);

  const contract = await generateContract(withAnswers);
  const withContract: InterviewSession = { ...withAnswers, contract };
  const tasks = await divideTasks(withContract);

  const totalEstimatedMinutes = tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
  const completed: InterviewSession = {
    ...withContract,
    tasks,
    totalEstimatedMinutes,
    status: "awaiting_approval",
    updatedAt: new Date().toISOString(),
  };
  await saveSession(completed);

  logger.info({ sessionId, tasks: tasks.length, totalEstimatedMinutes }, "Interview complete");

  return {
    nextQuestion: null,
    progress: `${TOTAL_QUESTIONS}/${TOTAL_QUESTIONS}`,
    isComplete: true,
    contract,
    tasks,
    totalEstimatedMinutes,
  };
}

export interface ApprovePlanResult {
  buildSessionId: string;
  tasks: TaskItem[];
  totalEstimatedMinutes: number;
  message: string;
}

export async function approvePlan(
  sessionId: string,
  approved: boolean,
  modifications?: string | undefined,
): Promise<ApprovePlanResult> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Interview session not found: ${sessionId}`);
  if (session.status !== "awaiting_approval") {
    throw new Error(`Session is in status '${session.status}', expected 'awaiting_approval'`);
  }
  if (!approved) throw new Error("Plan was rejected — call submitAnswer to restart");

  let finalSession = session;

  // If modifications requested, regenerate contract and tasks
  if (modifications && modifications.trim().length > 0) {
    const modifiedSession: InterviewSession = {
      ...session,
      initialPrompt: `${session.initialPrompt}\n\nModifications requested: ${modifications}`,
    };
    const contract = await generateContract(modifiedSession);
    const withContract = { ...modifiedSession, contract };
    const tasks = await divideTasks(withContract);
    const totalEstimatedMinutes = tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
    finalSession = {
      ...withContract,
      tasks,
      totalEstimatedMinutes,
      status: "approved",
      updatedAt: new Date().toISOString(),
    };
    await saveSession(finalSession);
  } else {
    finalSession = {
      ...session,
      status: "approved",
      updatedAt: new Date().toISOString(),
    };
    await saveSession(finalSession);
  }

  // Persist to DB and enqueue build job
  const buildSessionId = await kickOffBuild(finalSession);

  // Mark interview as building
  await saveSession({
    ...finalSession,
    status: "building",
    updatedAt: new Date().toISOString(),
  });

  return {
    buildSessionId,
    tasks: finalSession.tasks ?? [],
    totalEstimatedMinutes: finalSession.totalEstimatedMinutes ?? 0,
    message: "Build started. Monitor progress via WebSocket or GET /api/build/:id/status",
  };
}

// ── Build system integration ──────────────────────────────────────────────────

async function kickOffBuild(session: InterviewSession): Promise<string> {
  // Lazy import to avoid circular dependency with route modules
  const { db } = await import("../../db/client.js");
  const { buildSessions, projects } = await import("../../db/schema.js");
  const { enqueueFastBuild } = await import("../../build/queue.js");
  const { eq } = await import("drizzle-orm");

  const buildSessionId = crypto.randomUUID();
  const contractSummary = session.contract
    ? `App: ${session.contract.appType} | Scale: ${session.contract.scale} | Roles: ${session.contract.userRoles.join(", ")}`
    : "";

  await db.insert(buildSessions).values({
    id: buildSessionId,
    projectId: session.projectId,
    userId: session.userId,
    prompt: `${session.initialPrompt}\n\n${contractSummary}`,
    mode: "plan",
    status: "running",
    phase: 0,
    planStatus: "planning_complete",
    contractContent: session.contract ? JSON.stringify(session.contract) : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    planTasks: (session.tasks ?? null) as any,
  });

  await db
    .update(projects)
    .set({ status: "building" })
    .where(eq(projects.id, session.projectId));

  await enqueueFastBuild({
    sessionId: buildSessionId,
    projectId: session.projectId,
    userId: session.userId,
    prompt: session.initialPrompt,
  });

  logger.info(
    { interviewSessionId: session.id, buildSessionId },
    "Build session created from interview",
  );

  return buildSessionId;
}
