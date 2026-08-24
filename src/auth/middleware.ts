import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { AppError } from "../server/middleware/error-handler.js";
import { getSupabaseAdmin } from "./supabase-server.js";
import { db } from "../db/client.js";
import { user as userTable } from "../db/schema.js";
import { ensureBillingRow } from "../build/credits.js";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
};

export type AuthSession = {
  id: string;
  expiresAt: Date;
};

declare module "hono" {
  interface ContextVariableMap {
    authUser: AuthUser;
    authSession: AuthSession;
  }
}

export const requireAuth: MiddlewareHandler = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    throw new AppError(401, "Not authenticated", "UNAUTHORIZED");
  }

  const supabase = getSupabaseAdmin();
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user || !user.email) {
    throw new AppError(401, "Invalid or expired token", "UNAUTHORIZED");
  }

  // Decode JWT exp claim for session expiry (no network call needed).
  let expiresAt = new Date(Date.now() + 3_600_000);
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    ) as { exp?: number };
    if (payload.exp) expiresAt = new Date(payload.exp * 1000);
  } catch { /* leave default */ }

  const name: string =
    (user.user_metadata?.["full_name"] as string | undefined) ||
    (user.user_metadata?.["name"] as string | undefined) ||
    user.email.split("@")[0]!;

  const image: string | null =
    (user.user_metadata?.["avatar_url"] as string | undefined) || null;

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name,
    emailVerified: !!user.email_confirmed_at,
    image,
    createdAt: new Date(user.created_at),
  };

  // Upsert profile row so app FK references to user.id are satisfied.
  await db
    .insert(userTable)
    .values({
      id: authUser.id,
      email: authUser.email,
      name: authUser.name,
      emailVerified: authUser.emailVerified,
      image: authUser.image,
      createdAt: authUser.createdAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userTable.id,
      set: {
        email: authUser.email,
        name: authUser.name,
        emailVerified: authUser.emailVerified,
        image,
        updatedAt: new Date(),
      },
    });

  c.set("authUser", authUser);
  c.set("authSession", { id: user.id, expiresAt });

  // Ensure billing row exists (defaults to Free plan's monthly USD budget).
  // Fire-and-forget — never blocks the request.
  ensureBillingRow(authUser.id).catch(() => undefined);

  await next();
});
