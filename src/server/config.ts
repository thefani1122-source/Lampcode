import { z } from "zod";

// NODE_ENV is resolved before schema parse so we can gate behaviour on it.
const NODE_ENV = (process.env["NODE_ENV"] ?? "development") as
  | "development"
  | "production"
  | "test";

// All infra vars are optional at the schema level.
// Missing required vars are surfaced below with a clear message rather than
// a raw Zod parse error crashing the process before the HTTP server starts.
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  BASE_URL: z.string().url().optional(),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

// These vars must be present for the app to do useful work.
const REQUIRED_VARS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "OPENROUTER_API_KEY",
  "REDIS_URL",
  "BETTER_AUTH_SECRET",
] as const;

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Can only happen for PORT / NODE_ENV — always safe to throw here.
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

    // Always log — clear and visible in Railway build/runtime logs.
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

// Re-export with a type that treats required vars as strings so callers that
// access them after a guard don't need constant non-null assertions.
// At runtime a missing var is `undefined`; the module using it will throw a
// clear connection/auth error at first use rather than crashing on startup.
export const config = _env as Omit<typeof _env, (typeof REQUIRED_VARS)[number]> & {
  [K in (typeof REQUIRED_VARS)[number]]: string;
};

export type Config = typeof config;

// Origins allowed to make credentialed requests.
// Always includes the Vercel deployment and local dev; FRONTEND_ORIGIN covers
// any additional origin set via Railway env vars.
export const ALLOWED_ORIGINS = [
  ...new Set([
    "https://vibe-coder-suite.vercel.app",
    "http://localhost:3000",
    _env.FRONTEND_ORIGIN,
  ]),
];
