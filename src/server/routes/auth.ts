import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../../auth/better-auth.js";
import { requireAuth } from "../../auth/middleware.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

const authRouter = new Hono();

// POST /api/auth/register
authRouter.post("/register", async (c) => {
  const body = registerSchema.parse(await c.req.json());
  return auth.api.signUpEmail({
    body: { email: body.email, password: body.password, name: body.name },
    asResponse: true,
  });
});

// POST /api/auth/login
authRouter.post("/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  return auth.api.signInEmail({
    body: { email: body.email, password: body.password, rememberMe: body.rememberMe },
    asResponse: true,
  });
});

// POST /api/auth/logout
authRouter.post("/logout", requireAuth, async (c) => {
  return auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
});

// GET /api/auth/me
authRouter.get("/me", requireAuth, async (c) => {
  const user = c.get("authUser");
  const session = c.get("authSession");
  return c.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
    },
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
    },
  });
});

// POST /api/auth/refresh — validates the current session cookie and returns refreshed data
authRouter.post("/refresh", async (c) => {
  const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });
  if (sessionData === null || sessionData === undefined) {
    return c.json({ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }, 401);
  }
  return c.json({
    session: { id: sessionData.session.id, expiresAt: sessionData.session.expiresAt },
    user: { id: sessionData.user.id, email: sessionData.user.email, name: sessionData.user.name },
  });
});

export { authRouter };
