/**
 * Getting the eval harness a token, and keeping it valid.
 *
 * It used to require EVAL_TOKEN: a Supabase access token copied out of browser
 * storage by hand. Two problems with that, one annoying and one fatal.
 *
 * Annoying: you have to go find it, in a place that is not obvious.
 *
 * Fatal: those tokens last about an hour. A smoke run of four builds fits
 * inside that. The full twenty-task set is sixty minutes or more of real
 * builds, so the token expires partway through and every remaining task fails
 * with a 401 — which the report would show as `error` and which looks exactly
 * like the harness being broken.
 *
 * So the harness signs in itself, with the owner's email and password, and
 * refreshes before expiry. EVAL_TOKEN still works and takes precedence, for a
 * one-off run with a token from somewhere else.
 *
 * The anon key this uses is the public, client-side Supabase key — the same one
 * the frontend bundle ships to every visitor. It is not a secret. The PASSWORD
 * is, which is why it only ever comes from the environment and is never logged.
 */

const DEFAULT_SUPABASE_URL = "https://kkyzhykycqydcguqdxye.supabase.co";

/** Refresh this long before the token actually expires, so a request issued
 *  just under the wire does not land just over it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TokenProvider = {
  /** A valid access token, refreshed if it is close to expiring. */
  token: () => Promise<string>;
  /** How this provider got its token, for the run's own log line. */
  describe: () => string;
};

type Session = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
};

/**
 * Should the session be renewed before being used again?
 *
 * Pure and exported so the margin is testable without a network call or a
 * sixty-minute wait. Getting this wrong is silent: too eager wastes calls, too
 * lazy fails the run with a 401 at minute 58.
 */
export function needsRefresh(session: Session, now: number, marginMs = REFRESH_MARGIN_MS): boolean {
  return session.expiresAt - now <= marginMs;
}

type SupabaseTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  msg?: string;
  error?: string;
};

async function requestToken(
  supabaseUrl: string,
  anonKey: string,
  body: Record<string, string>,
  grantType: "password" | "refresh_token",
): Promise<Session> {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: SupabaseTokenResponse = {};
  try {
    parsed = JSON.parse(text) as SupabaseTokenResponse;
  } catch {
    // Keep the raw text in the error below — an HTML error page from a proxy
    // is worth seeing verbatim.
  }

  if (!res.ok || !parsed.access_token) {
    // Never include the request body: it holds the password on the sign-in path.
    const why =
      parsed.error_description ?? parsed.msg ?? parsed.error ?? text.slice(0, 200);
    throw new Error(
      grantType === "password"
        ? `Could not sign in as EVAL_EMAIL: ${why}`
        : `Could not refresh the eval session: ${why}`,
    );
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    // Supabase returns seconds. Default to an hour, the usual value, if absent.
    expiresAt: Date.now() + (parsed.expires_in ?? 3_600) * 1_000,
  };
}

/**
 * Build the provider the runner uses. Resolution order:
 *  1. EVAL_TOKEN — used as-is, never refreshed (it is somebody else's token).
 *  2. EVAL_EMAIL + EVAL_PASSWORD — signed in here and refreshed as needed.
 * Throws with instructions if neither is available.
 */
export function createTokenProvider(env: Record<string, string | undefined>): TokenProvider {
  const staticToken = env["EVAL_TOKEN"]?.trim();
  if (staticToken) {
    return {
      token: () => Promise.resolve(staticToken),
      describe: () =>
        "EVAL_TOKEN (fixed — it cannot be refreshed, so a run longer than its " +
        "lifetime will start failing with 401s partway through)",
    };
  }

  const email = env["EVAL_EMAIL"]?.trim();
  const password = env["EVAL_PASSWORD"];
  const supabaseUrl = (env["EVAL_SUPABASE_URL"]?.trim() || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  const anonKey = env["EVAL_SUPABASE_ANON_KEY"]?.trim();

  if (!email || !password) {
    throw new Error(
      "The eval harness needs to sign in. Set EVAL_EMAIL and EVAL_PASSWORD to the\n" +
      "account that is allowed to build — an admin account while WAITLIST_MODE is on.\n" +
      "EVAL_SUPABASE_ANON_KEY is also needed (the public client key, the same one the\n" +
      "frontend ships; EVAL_SUPABASE_URL defaults to this project's).\n" +
      "Alternatively set EVAL_TOKEN to an access token you already have, but note it\n" +
      "expires in about an hour, which is shorter than a full eval run.",
    );
  }
  if (!anonKey) {
    throw new Error(
      "EVAL_SUPABASE_ANON_KEY is not set. It is the PUBLIC Supabase client key — the\n" +
      "same value the frontend bundle ships to every visitor, not a secret — and it is\n" +
      "what lets this script call the auth endpoint. Find it in the frontend's env as\n" +
      "VITE_SUPABASE_ANON_KEY, or in the Supabase dashboard under API keys.",
    );
  }

  let session: Session | null = null;
  // One shared promise so several parallel tasks starting at once cannot each
  // kick off their own sign-in.
  let inflight: Promise<Session> | null = null;

  const ensure = async (): Promise<Session> => {
    if (session && !needsRefresh(session, Date.now())) return session;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        if (session?.refreshToken) {
          try {
            return await requestToken(
              supabaseUrl, anonKey, { refresh_token: session.refreshToken }, "refresh_token",
            );
          } catch {
            // A refused refresh is not fatal — signing in again is the same
            // outcome by a longer road, and the password is still here.
          }
        }
        return await requestToken(supabaseUrl, anonKey, { email, password }, "password");
      } finally {
        inflight = null;
      }
    })();

    session = await inflight;
    return session;
  };

  return {
    token: async () => (await ensure()).accessToken,
    describe: () => `signed in as ${email} (refreshes itself)`,
  };
}
