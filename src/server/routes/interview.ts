import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { INTERVIEW_QUESTIONS, TOTAL_QUESTIONS } from "../data/interview-questions.js";
import {
  createSession,
  getSession,
  submitAnswer,
  approvePlan,
} from "../services/interview.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";

// ── WS helper — never throws ──────────────────────────────────────────────────

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const startBodySchema = z.object({
  projectId: z.string().min(1),
  initialPrompt: z.string().min(1).max(4_000),
});

const answerBodySchema = z.object({
  sessionId: z.string().uuid(),
  answer: z.object({
    questionId: z.string().min(1),
    selectedOption: z.string().min(1),
    customInput: z.string().max(1_000).optional(),
  }),
});

const approveBodySchema = z.object({
  approved: z.boolean(),
  modifications: z.string().max(2_000).optional(),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const interviewRouter = new Hono();
interviewRouter.use("/*", requireAuth);

// POST /api/interview/start
interviewRouter.post("/start", async (c) => {
  const authUser = c.get("authUser");

  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = startBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  const { projectId, initialPrompt } = parsed.data;

  const { session, firstQuestion } = await createSession(
    projectId,
    authUser.id,
    initialPrompt,
  );

  ws()?.emitInterviewQuestion(session.id, {
    sessionId: session.id,
    question: firstQuestion,
    progress: `1/${TOTAL_QUESTIONS}`,
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId: session.id, projectId }, "Interview started");

  return c.json(
    {
      sessionId: session.id,
      question: firstQuestion,
      progress: `1/${TOTAL_QUESTIONS}`,
    },
    201,
  );
});

// POST /api/interview/answer
interviewRouter.post("/answer", async (c) => {
  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = answerBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  const { sessionId, answer } = parsed.data;

  const session = await getSession(sessionId);
  if (!session) throw new AppError(404, "Interview session not found", "NOT_FOUND");

  // Validate the answer matches the current question
  const currentQuestion = INTERVIEW_QUESTIONS[session.currentQuestionIndex];
  if (!currentQuestion || currentQuestion.id !== answer.questionId) {
    throw new AppError(
      400,
      `Expected answer for question '${currentQuestion?.id}', got '${answer.questionId}'`,
      "VALIDATION_ERROR",
    );
  }

  const result = await submitAnswer(sessionId, answer);

  if (result.nextQuestion) {
    ws()?.emitInterviewQuestion(sessionId, {
      sessionId,
      question: result.nextQuestion,
      progress: result.progress,
      timestamp: new Date().toISOString(),
    });
  } else if (result.contract) {
    ws()?.emitInterviewContract(sessionId, {
      sessionId,
      contract: result.contract,
      tasks: result.tasks ?? [],
      totalEstimatedMinutes: result.totalEstimatedMinutes ?? 0,
      timestamp: new Date().toISOString(),
    });
  }

  return c.json({
    nextQuestion: result.nextQuestion ?? null,
    progress: result.progress,
    isComplete: result.isComplete,
    ...(result.contract !== undefined ? { contract: result.contract } : {}),
    ...(result.tasks !== undefined ? { tasks: result.tasks } : {}),
    ...(result.totalEstimatedMinutes !== undefined
      ? { totalEstimatedMinutes: result.totalEstimatedMinutes }
      : {}),
  });
});

// GET /api/interview/:sessionId
interviewRouter.get("/:sessionId", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const session = await getSession(sessionId);
  if (!session) throw new AppError(404, "Interview session not found", "NOT_FOUND");
  if (session.userId !== authUser.id) {
    throw new AppError(403, "Not authorized to view this session", "FORBIDDEN");
  }

  const currentQuestion =
    session.status === "in_progress"
      ? INTERVIEW_QUESTIONS[session.currentQuestionIndex]
      : null;

  return c.json({
    session,
    currentQuestion: currentQuestion ?? null,
    progress: `${Math.min(session.currentQuestionIndex + 1, TOTAL_QUESTIONS)}/${TOTAL_QUESTIONS}`,
  });
});

// POST /api/interview/:sessionId/approve
interviewRouter.post("/:sessionId/approve", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = approveBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  const { approved, modifications } = parsed.data;

  const session = await getSession(sessionId);
  if (!session) throw new AppError(404, "Interview session not found", "NOT_FOUND");
  if (session.userId !== authUser.id) {
    throw new AppError(403, "Not authorized", "FORBIDDEN");
  }

  if (!approved) {
    return c.json({ status: "rejected", message: "Send updated answers to restart the interview" });
  }

  const result = await approvePlan(sessionId, true, modifications);

  ws()?.emitInterviewApproved(sessionId, {
    sessionId,
    buildSessionId: result.buildSessionId,
    tasks: result.tasks,
    totalEstimatedMinutes: result.totalEstimatedMinutes,
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, buildSessionId: result.buildSessionId }, "Interview approved, build queued");

  return c.json({
    buildId: result.buildSessionId,
    tasks: result.tasks,
    totalEstimatedMinutes: result.totalEstimatedMinutes,
    message: result.message,
  });
});
