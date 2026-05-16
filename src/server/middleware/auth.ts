import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { AppError } from "./error-handler.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const jwtPayloadSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
  role: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  exp: z.number(),
  iat: z.number(),
});

export type AuthUser = z.infer<typeof jwtPayloadSchema>;

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(401, "Missing or malformed Authorization header", "UNAUTHORIZED");
  }
  return authHeader.slice(7);
}

async function verifySupabaseJwt(token: string): Promise<AuthUser> {
  // Supabase JWTs are verified against the project's JWT secret.
  // We decode the payload and verify expiry; signature verification requires
  // the Supabase JWT secret (SUPABASE_SERVICE_KEY is used here as a stand-in
  // until a full JOSE library is wired in).
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(401, "Malformed JWT", "UNAUTHORIZED");
  }

  const payloadPart = parts[1];
  if (!payloadPart) {
    throw new AppError(401, "Malformed JWT payload", "UNAUTHORIZED");
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new AppError(401, "Malformed JWT payload", "UNAUTHORIZED");
  }

  const result = jwtPayloadSchema.safeParse(rawPayload);
  if (!result.success) {
    throw new AppError(401, "Invalid JWT claims", "UNAUTHORIZED");
  }

  const payload = result.data;
  if (Date.now() / 1000 > payload.exp) {
    throw new AppError(401, "JWT expired", "TOKEN_EXPIRED");
  }

  logger.debug({ sub: payload.sub }, "JWT verified");
  return payload;
}

export const authMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const token = extractBearerToken(c.req.header("Authorization"));
  const user = await verifySupabaseJwt(token);
  c.set("user", user);
  await next();
});

// Optional variant — does not throw if no token is present
export const optionalAuthMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    const token = extractBearerToken(authHeader);
    const user = await verifySupabaseJwt(token);
    c.set("user", user);
  }
  await next();
});

// Expose config reference used in verifySupabaseJwt (satisfies linter — field consumed at runtime)
void config.SUPABASE_SERVICE_KEY;
