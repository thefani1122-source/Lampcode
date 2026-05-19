import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, type BetterAuthSession, type BetterAuthUser } from "./better-auth.js";
import { AppError } from "../server/middleware/error-handler.js";

declare module "hono" {
  interface ContextVariableMap {
    authUser: BetterAuthUser;
    authSession: BetterAuthSession;
  }
}

export const requireAuth: MiddlewareHandler = createMiddleware(async (c, next) => {
  const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });
  if (sessionData === null || sessionData === undefined) {
    throw new AppError(401, "Not authenticated", "UNAUTHORIZED");
  }
  c.set("authUser", sessionData.user);
  c.set("authSession", sessionData.session);
  await next();
});
