import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.js";

// Supabase Auth handles sign-in, sign-up, OAuth, and session management
// directly from the browser — no server-side auth endpoints needed.
// These two routes exist for the frontend to fetch the current user/session
// after a successful Supabase sign-in.

const authRouter = new Hono();

// GET /api/auth/me — return the authenticated user's profile
authRouter.get("/me", requireAuth, (c) => {
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

// POST /api/auth/refresh — validate the Bearer token and return user/session info
authRouter.post("/refresh", requireAuth, (c) => {
  const user = c.get("authUser");
  const session = c.get("authSession");
  return c.json({
    session: { id: session.id, expiresAt: session.expiresAt },
    user: { id: user.id, email: user.email, name: user.name },
  });
});

export { authRouter };
