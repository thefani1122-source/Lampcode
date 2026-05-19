import { Redis } from "ioredis";
import { z } from "zod";
import { type Phase, type AgentType } from "./state-machine.js";
import { logger } from "../server/logger.js";

// ── Plan tiers ────────────────────────────────────────────────────────────────

const planTierSchema = z.enum(["free", "pro", "enterprise"]);
export type PlanTier = z.infer<typeof planTierSchema>;

const PLAN_LIMITS: Record<PlanTier, { creditsPerMonth: number }> = {
  free: { creditsPerMonth: 100 },
  pro: { creditsPerMonth: 1_000 },
  enterprise: { creditsPerMonth: Number.MAX_SAFE_INTEGER },
};

// Credits burned per agent call (estimated at planning time, actuals tracked per-call)
const AGENT_CREDIT_COSTS: Record<AgentType, number> = {
  architect: 12,
  database: 15,
  backend: 22,
  frontend: 22,
  devops: 10,
};

// Per-phase cost multiplier for mode
const PHASE_MODE_MULTIPLIER: Record<"fast" | "plan", number> = {
  fast: 1.0,
  plan: 1.6, // "plan" mode is more thorough
};

// ── Result types ──────────────────────────────────────────────────────────────

export interface CreditCheckResult {
  allowed: boolean;
  remaining: number;
  estimate: number;
}

export interface BurnResult {
  totalUsed: number;
  remaining: number;
  overBudget: boolean;
}

// ── Redis keys ────────────────────────────────────────────────────────────────

function monthKey(userId: string): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `bf:credits:${userId}:${ym}`;
}

function sessionBurnKey(sessionId: string): string {
  return `bf:burn:${sessionId}`;
}

const MONTH_TTL_SECONDS = 60 * 60 * 24 * 35; // 35 days — covers full calendar month

// ── CreditGuard ───────────────────────────────────────────────────────────────

export class CreditGuard {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }

  /** Estimate total credit cost for a full build and check if it's within budget. */
  async checkBudget(
    userId: string,
    mode: "fast" | "plan",
    phases: Phase[],
    planTier: PlanTier = "free",
  ): Promise<CreditCheckResult> {
    const estimate = this.estimateCost(phases, mode);
    const used = await this.getMonthlyUsed(userId);
    const limit = PLAN_LIMITS[planTier].creditsPerMonth;
    const remaining = Math.max(0, limit - used);

    return {
      allowed: estimate <= remaining,
      remaining,
      estimate,
    };
  }

  /** Record credit burn for a single agent call. Returns current totals. */
  async trackBurn(
    sessionId: string,
    userId: string,
    agentType: AgentType,
    credits: number,
    planTier: PlanTier = "free",
  ): Promise<BurnResult> {
    const mKey = monthKey(userId);
    const sKey = sessionBurnKey(sessionId);

    // Atomic increment on both keys
    const [monthlyRaw, sessionRaw] = await Promise.all([
      this.redis.incrbyfloat(mKey, credits),
      this.redis.incrbyfloat(sKey, credits),
    ]);

    // Ensure TTL is set (incrbyfloat creates the key if missing)
    await Promise.all([
      this.redis.expire(mKey, MONTH_TTL_SECONDS),
      this.redis.expire(sKey, 60 * 60 * 24 * 7), // 7 days for session data
    ]);

    const totalUsed = parseFloat(monthlyRaw);
    const limit = PLAN_LIMITS[planTier].creditsPerMonth;
    const remaining = Math.max(0, limit - totalUsed);
    const overBudget = totalUsed > limit;

    logger.debug(
      { sessionId, agentType, credits, totalUsed, remaining, overBudget },
      "Credit burn tracked",
    );

    void sessionRaw; // acknowledged — per-session burn tracked for audit
    return { totalUsed, remaining, overBudget };
  }

  /** Get remaining credits for the current calendar month. */
  async getRemainingCredits(
    userId: string,
    planTier: PlanTier = "free",
  ): Promise<{ used: number; remaining: number; limit: number }> {
    const used = await this.getMonthlyUsed(userId);
    const limit = PLAN_LIMITS[planTier].creditsPerMonth;
    return { used, remaining: Math.max(0, limit - used), limit };
  }

  /** Get per-session credit burn total. */
  async getSessionBurn(sessionId: string): Promise<number> {
    const raw = await this.redis.get(sessionBurnKey(sessionId));
    return raw !== null ? parseFloat(raw) : 0;
  }

  close(): void {
    this.redis.disconnect();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private estimateCost(phases: Phase[], mode: "fast" | "plan"): number {
    const multiplier = PHASE_MODE_MULTIPLIER[mode];
    let total = 0;
    for (const phase of phases) {
      if (phase === "IDLE") continue;
      const { requiredAgents } = getPhaseAgents(phase);
      for (const agent of requiredAgents) {
        total += (AGENT_CREDIT_COSTS[agent] ?? 10) * multiplier;
      }
    }
    return Math.ceil(total);
  }

  private async getMonthlyUsed(userId: string): Promise<number> {
    const raw = await this.redis.get(monthKey(userId));
    return raw !== null ? parseFloat(raw) : 0;
  }
}

// Inline import to avoid circular dep with state-machine (only need agent lists)
function getPhaseAgents(phase: Phase): { requiredAgents: AgentType[] } {
  const map: Record<Phase, AgentType[]> = {
    IDLE: [],
    PLANNING: ["architect"],
    FOUNDATION: ["architect", "database"],
    BUILD: ["backend", "frontend"],
    VERIFY: ["devops"],
    DEPLOY: ["devops"],
  };
  return { requiredAgents: map[phase] };
}
