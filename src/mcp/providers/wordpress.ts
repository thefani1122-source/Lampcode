import { z } from "zod";
import { fetchJson, withRetry, type ProviderDef } from "./_shared.js";

// ── WordPress (+ WooCommerce) via the REST API ───────────────────────────────
// Auth: WordPress Application Password (Basic auth). WooCommerce endpoints are
// served at /wp-json/wc/v3 on the same site and accept the same Basic auth.

export const wordpressSchema = z.object({
  siteUrl: z.string().url("Must be a full URL, e.g. https://myblog.com"),
  username: z.string().min(1, "Username is required"),
  appPassword: z.string().min(1, "Application password is required"),
});
export type WordPressParams = z.infer<typeof wordpressSchema>;

const base = (p: WordPressParams): string => p.siteUrl.replace(/\/+$/, "") + "/wp-json";
const authHeaders = (p: WordPressParams): Record<string, string> => ({
  Authorization: "Basic " + Buffer.from(`${p.username}:${p.appPassword}`).toString("base64"),
  "Content-Type": "application/json",
});

export async function getPosts(p: WordPressParams, perPage = 20): Promise<unknown> {
  return fetchJson(`${base(p)}/wp/v2/posts?per_page=${perPage}`, { headers: authHeaders(p) });
}

export async function createPost(
  p: WordPressParams,
  title: string,
  content: string,
  status: "publish" | "draft" | "pending" = "draft",
): Promise<unknown> {
  return fetchJson(`${base(p)}/wp/v2/posts`, {
    method: "POST",
    headers: authHeaders(p),
    body: JSON.stringify({ title, content, status }),
  });
}

export async function getPages(p: WordPressParams): Promise<unknown> {
  return fetchJson(`${base(p)}/wp/v2/pages`, { headers: authHeaders(p) });
}

// WooCommerce (if installed)
export async function getProducts(p: WordPressParams): Promise<unknown> {
  return fetchJson(`${base(p)}/wc/v3/products`, { headers: authHeaders(p) });
}

export async function createOrder(p: WordPressParams, order: Record<string, unknown>): Promise<unknown> {
  return fetchJson(`${base(p)}/wc/v3/orders`, {
    method: "POST",
    headers: authHeaders(p),
    body: JSON.stringify(order),
  });
}

export async function testConnection(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const parsed = wordpressSchema.safeParse(params);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  try {
    // /users/me requires valid auth — the cheapest authenticated check.
    await withRetry(async () => {
      const res = await fetch(`${base(parsed.data)}/wp/v2/users/me`, {
        headers: authHeaders(parsed.data),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error("Invalid username or application password");
      if (!res.ok) throw new Error(`WordPress responded ${res.status}`);
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const wordpress: ProviderDef = {
  id: "wordpress",
  name: "WordPress",
  category: "Productivity",
  emoji: "📝",
  description: "Read/write posts, pages, media and WooCommerce products & orders via the WordPress REST API.",
  schema: wordpressSchema,
  fields: [
    { key: "siteUrl", label: "Site URL", type: "url", placeholder: "https://myblog.com" },
    { key: "username", label: "Username", type: "text", placeholder: "admin" },
    { key: "appPassword", label: "Application Password", type: "password", placeholder: "xxxx xxxx xxxx xxxx", help: "WP Admin → Users → Profile → Application Passwords." },
  ],
  testConnection,
  keywords: /\b(wordpress|wp|woocommerce|blog post|cms)\b/i,
  promptRule: `WORDPRESS: the user connected a WordPress site. Generate code that calls the
WordPress REST API with Basic auth (Application Password), e.g.:
  fetch(\`\${siteUrl}/wp-json/wp/v2/posts\`, { headers: { Authorization: 'Basic ' + btoa(username + ':' + appPassword) } })
WooCommerce products/orders live at /wp-json/wc/v3/products and /wc/v3/orders.
Read creds from env (process.env.WORDPRESS_SITE_URL, _USERNAME, _APP_PASSWORD)
in the backend — never hardcode or expose the app password to the frontend.`,
};
