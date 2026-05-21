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
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_PUBLIC_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
});

const REQUIRED_VARS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "OPENROUTER_API_KEY",
  "REDIS_URL",
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
export const ALLOWED_ORIGINS = [
  ...new Set([
    "https://lampcode-production.up.railway.app",
    "https://vibe-coder-suite.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
    _env.FRONTEND_ORIGIN,
    _env.FRONTEND_URL,
  ].filter(Boolean) as string[]),
];
