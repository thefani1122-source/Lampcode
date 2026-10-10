import { z } from "zod";

const NODE_ENV = (process.env["NODE_ENV"] ?? "development") as
  | "development"
  | "production"
  | "test";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  E2B_API_KEY: z.string().min(1).optional(),
  // Internal platform-level MCP tools — loaded automatically, not user-configured
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),
  // Supabase project whose URL + anon key get injected into every preview
  // sandbox so generated Supabase-direct apps can initialise their client and
  // render. The anon key is public (RLS-protected) — safe to embed in previews.
  PREVIEW_SUPABASE_URL: z.string().url().optional(),
  PREVIEW_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  // Service-role key for the shared preview project. Injected ONLY into the
  // backend process env (never VITE_, never the frontend) so generated Node/Hono
  // backends can do real server-side work (bypass RLS, admin writes, webhooks).
  PREVIEW_SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  // Shared preview MongoDB connection string — injected into the backend env
  // (MONGODB_URI) so generated MongoDB apps can connect & persist in the preview.
  PREVIEW_MONGODB_URI: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_PUBLIC_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PRO: z.string().min(1).optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().min(1).optional(),
  // Paddle runs alongside Stripe (additive, see billing.ts/webhooks.ts) — not
  // a replacement. PADDLE_CLIENT_TOKEN is the public, non-secret token
  // Paddle.js needs client-side; safe to return from an API response.
  PADDLE_API_KEY: z.string().min(1).optional(),
  PADDLE_WEBHOOK_SECRET: z.string().min(1).optional(),
  PADDLE_CLIENT_TOKEN: z.string().min(1).optional(),
  PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  PADDLE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
  PADDLE_PRICE_PRO_YEARLY: z.string().min(1).optional(),
  PADDLE_PRICE_MAX_MONTHLY: z.string().min(1).optional(),
  PADDLE_PRICE_MAX_YEARLY: z.string().min(1).optional(),
  PADDLE_PRICE_POWER_MONTHLY: z.string().min(1).optional(),
  PADDLE_PRICE_POWER_YEARLY: z.string().min(1).optional(),
  PADDLE_PRICE_TOPUP_5: z.string().min(1).optional(),
  PADDLE_PRICE_TOPUP_15: z.string().min(1).optional(),
  PADDLE_PRICE_TOPUP_30: z.string().min(1).optional(),
  PADDLE_PRICE_TOPUP_75: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)").optional(),
  // Modal-hosted open-weight model (OpenAI-compatible Chat Completions API) —
  // routed to free-tier builds only, see modal-gateway.ts/dispatcher.ts. All
  // three must be set together for the free-tier path to work; when any is
  // missing, dispatcher.ts falls back to Anthropic for every plan (never a
  // silent partial-Modal state).
  // Preferred names. The MODAL_* names below still work and are read as a
  // fallback, but they are misleading now: this is any OpenAI-compatible
  // /v1/chat/completions endpoint — Moonshot, Z.ai, a self-hosted model on
  // Modal, anything. Nothing about it is Modal-specific, and reading
  // "MODAL_ENDPOINT_URL = https://api.moonshot.ai" in a dashboard invites
  // exactly the wrong conclusion about where the model is coming from.
  LLM_ENDPOINT_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL_NAME: z.string().min(1).optional(),
  MODAL_ENDPOINT_URL: z.string().url().optional(),
  MODAL_PROXY_TOKEN: z.string().min(1).optional(),
  MODAL_MODEL_NAME: z.string().min(1).optional(),
  // Which gateway every build uses, overriding the per-plan routing.
  //   "auto" (default) — free plans use the OpenAI-compatible endpoint, paid
  //                      plans use Anthropic. This is the shipping behaviour.
  //   "openai"         — EVERY build uses LLM_ENDPOINT_URL, whatever the plan.
  //   "anthropic"      — EVERY build uses Anthropic, whatever the plan.
  // "openai" exists because plan-based routing makes the product impossible to
  // test on the model you actually intend to ship: an admin or paid account
  // silently gets Anthropic, so a GLM/Kimi setup can be fully configured and
  // never once exercised.
  LLM_PROVIDER_MODE: z.enum(["auto", "openai", "anthropic"]).default("auto"),
  // Reasoning depth sent to the OpenAI-compatible endpoint. "low" preserves
  // the value tuned against GLM-5.3 (which forces reasoning on and would
  // otherwise spend the whole token budget thinking). "off" omits the field
  // entirely — the right setting for any model that doesn't accept it.
  MODAL_REASONING_EFFORT: z
    .enum(["off", "low", "medium", "high", "max"])
    .default("low"),
  // Ceiling sent as `max_tokens` on the OpenAI-compatible path. It is a
  // PER-MODEL limit, not a preference: MiniMax M2.5 caps output at 8K while
  // Kimi K2.5 allows 16K, and asking for more than a model permits is either
  // rejected outright or silently clamped — neither of which announces itself.
  // Default stays 16000 so nothing changes for the models already in use.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16_000),
  // Multiplier applied to real per-dispatch costUsd to produce the billed
  // usage_usd amount. Covers real profit margin AND infra cost costUsd
  // doesn't capture (E2B sandbox compute, Railway hosting, Redis, bandwidth —
  // costUsd only measures LLM token spend). Provisional default; revisit once
  // real all-in cost-per-build is measured post-launch.
  USAGE_MARGIN_MULTIPLIER: z.coerce.number().positive().default(4),
  // Pre-launch waitlist. While on, /api/build/fast refuses non-admin requests
  // so no build spend can be triggered by someone who bypasses the frontend.
  // Defaults to ON: leaving the waitlist up by mistake is a visible annoyance
  // fixed in seconds, while opening builds to everyone by mistake costs real
  // Anthropic and E2B money. Set WAITLIST_MODE=false to open the product.
  // Parsed explicitly, not with z.coerce.boolean() — Boolean("false") is true,
  // so a coerced flag set to "false" would switch this ON.
  WAITLIST_MODE: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() !== "false")
    .pipe(z.boolean()),
  // Agentic build loop (see tools.ts AGENTIC_BUILD_TOOLS). When on, a NEW
  // paid-tier build hands the model real sandbox tools and lets it drive:
  // write files, look at the rendered page, repair, repeat — instead of
  // build.ts running a fixed pipeline around a one-shot generation. Off by
  // default so the existing path stays the default until this is proven; it
  // costs materially more per build (many model turns instead of one), which
  // is why it never applies to the free/Modal tier.
  // NOT z.coerce.boolean() — that runs JS Boolean() over the raw env string, so
  // the string "false" (and "0") coerce to TRUE. Setting the var to "false" to
  // switch this off would have silently switched it on, with real money
  // attached. Only an explicit "true"/"1" enables it.
  // Default flipped to TRUE on 2026-10-03, after 20 real builds across all
  // three eval tiers: 20/20 built, 0 build failures, 0 harness errors, the turn
  // cap never reached, and the core tier 11/11 on every check. The flag stays
  // as a kill switch — set it to "false" and the fence-parsing path takes over
  // — but the agentic harness is now what a build gets unless someone says
  // otherwise. Only an explicit "false"/"0" disables it, parsed as a string for
  // the same reason as before: z.coerce.boolean() reads "false" as true, so a
  // var set to turn this OFF would have turned it on, with real money attached.
  AGENTIC_BUILD_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? true : !(v === "false" || v === "0")))
    .pipe(z.boolean()),
  // Hard ceiling on model turns inside one agentic build. The cost guard is
  // the real budget limit; this is the belt-and-braces stop so a model that
  // never says "done" can't spin.
  AGENTIC_MAX_TURNS: z.coerce.number().int().positive().default(12),
  // One cheap dispatch before a LONG new build, producing a file-by-file plan
  // the build then executes against. Only ever runs for big new builds (see
  // shouldPlan in build-planner.ts) — a small app does not need a plan and
  // should not pay for one. Set to "false" to switch it off entirely.
  // Same explicit-string parsing as AGENTIC_BUILD_ENABLED above, and for the
  // same reason: z.coerce.boolean() would read "false" as true.
  BUILD_PLANNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === "" ? true : v === "true" || v === "1")
    .pipe(z.boolean()),
  // A LOW bar that only screens out one-liners — not a complexity test.
  // Measured on 2026-10-03: across the twenty eval prompts, word count cannot
  // separate the tiers (hard 41-62, core 38-51, smoke 29-50 words overlap), and
  // the old 60 let only 1 of 5 hard builds plan. 38 is where the smoke tier
  // ends and core begins; shouldPlan's own signals force a plan for a terse but
  // multi-screen or logic-heavy prompt regardless of this.
  BUILD_PLAN_MIN_WORDS: z.coerce.number().int().positive().default(38),
  // The outside check on whether the build did what was asked — two cheap
  // dispatches that cannot write a file (src/verify/completion-audit.ts).
  // Same explicit-string parsing as the two flags above, same reason.
  // A kill switch with no size threshold: a six-file build missed a stated
  // requirement (Finding 4), so "small" is not a reason to skip the audit.
  COMPLETION_AUDIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === "" ? true : v === "true" || v === "1")
    .pipe(z.boolean()),
});

const REQUIRED_VARS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "ANTHROPIC_API_KEY",
  "REDIS_URL",
  "ENCRYPTION_KEY",
] as const;

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment variable error:\n${issues}`);
  }

  const data = result.data;

  const missing = REQUIRED_VARS.filter(
    (key) => data[key] === undefined || data[key] === "",
  );

  if (missing.length > 0) {
    const list = missing.map((k) => `  - ${k}`).join("\n");
    const hint =
      NODE_ENV === "production"
        ? "Set these in your Railway dashboard → Variables."
        : "Add them to your .env file.";

    console.error(
      [
        "",
        "╔══════════════════════════════════════════════════════╗",
        "║       MISSING REQUIRED ENVIRONMENT VARIABLES         ║",
        "╚══════════════════════════════════════════════════════╝",
        list,
        "",
        hint,
        "The server will start but most endpoints will be unavailable",
        "until these variables are configured.",
        "",
      ].join("\n"),
    );
  }

  return data;
}

const _env = parseEnv();

export const config = _env as Omit<typeof _env, (typeof REQUIRED_VARS)[number]> & {
  [K in (typeof REQUIRED_VARS)[number]]: string;
};

export type Config = typeof config;

// Origins allowed to make credentialed requests.
const isDev = NODE_ENV !== "production";
export const ALLOWED_ORIGINS = [
  "https://lampcode-production.up.railway.app",
  "https://vibe-coder-suite.vercel.app",
  ...(isDev ? ["http://localhost:3000", "http://localhost:5173"] : []),
  ...(process.env["FRONTEND_ORIGIN"] ? [process.env["FRONTEND_ORIGIN"]] : []),
  ...(process.env["FRONTEND_URL"] ? [process.env["FRONTEND_URL"]] : []),
].filter(Boolean) as string[];
