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
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)").optional(),
  // Multiplier applied to real per-dispatch costUsd to produce the billed
  // usage_usd amount. Covers real profit margin AND infra cost costUsd
  // doesn't capture (E2B sandbox compute, Railway hosting, Redis, bandwidth —
  // costUsd only measures LLM token spend). Provisional default; revisit once
  // real all-in cost-per-build is measured post-launch.
  USAGE_MARGIN_MULTIPLIER: z.coerce.number().positive().default(4),
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
