import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/client.js";
import { user, session, account, verification } from "../db/schema.js";
import { config } from "../server/config.js";

type BetterAuthInit = Parameters<typeof betterAuth>[0];
type SocialProviders = NonNullable<BetterAuthInit["socialProviders"]>;

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

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: { enabled: true },
  socialProviders,
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BASE_URL ?? `http://localhost:${config.PORT}`,
  trustedOrigins: [config.FRONTEND_ORIGIN],
});

export type Auth = typeof auth;

// Infer session/user types from the auth instance
export type BetterAuthSession = typeof auth.$Infer.Session.session;
export type BetterAuthUser = typeof auth.$Infer.Session.user;
