import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/client.js";
import { user, session, account, verification } from "../db/schema.js";
import { config, ALLOWED_ORIGINS } from "../server/config.js";

type BetterAuthInstance = ReturnType<typeof betterAuth>;
type SocialProviders = NonNullable<BetterAuthOptions["socialProviders"]>;

// Lazy initialisation: defer betterAuth() call until first use so the server
// can start and serve /health even when auth vars are not yet configured.
let _auth: BetterAuthInstance | null = null;

function getAuth(): BetterAuthInstance {
  if (_auth !== null) return _auth;

  if (!config.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Configure it in Railway → Variables.",
    );
  }

  const socialProviders: SocialProviders = {};

  if (config.GITHUB_CLIENT_ID !== undefined && config.GITHUB_CLIENT_SECRET !== undefined) {
    socialProviders.github = {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
    };
  }

  if (config.GOOGLE_CLIENT_ID !== undefined && config.GOOGLE_CLIENT_SECRET !== undefined) {
    socialProviders.google = {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true },
    socialProviders,
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BASE_URL ?? `http://localhost:${config.PORT}`,
    trustedOrigins: ALLOWED_ORIGINS,
  } as BetterAuthOptions);

  return _auth;
}

// Proxy so callers use `auth.handler(...)` etc. as before without changes.
export const auth = new Proxy({} as BetterAuthInstance, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Reflect.get(getAuth() as any, prop);
  },
});

export type Auth = typeof auth;
export type BetterAuthSession = BetterAuthInstance["$Infer"]["Session"]["session"];
export type BetterAuthUser = BetterAuthInstance["$Infer"]["Session"]["user"];
