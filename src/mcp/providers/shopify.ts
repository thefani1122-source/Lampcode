import { z } from "zod";
import { fetchJson, withRetry, type ProviderDef } from "./_shared.js";

// ── Shopify (Storefront API for catalog/cart, Admin API for orders/webhooks) ──

export const shopifySchema = z.object({
  shopDomain: z.string().regex(/^[a-z0-9-]+\.myshopify\.com$/i, "Must look like my-store.myshopify.com"),
  storefrontAccessToken: z.string().min(1, "Storefront access token is required"),
  adminApiAccessToken: z.string().min(1).optional(),
});
export type ShopifyParams = z.infer<typeof shopifySchema>;

const STOREFRONT_API_VERSION = "2024-10";
const ADMIN_API_VERSION = "2024-10";

const storefrontUrl = (p: ShopifyParams): string =>
  `https://${p.shopDomain}/api/${STOREFRONT_API_VERSION}/graphql.json`;
const adminUrl = (p: ShopifyParams, path: string): string =>
  `https://${p.shopDomain}/admin/api/${ADMIN_API_VERSION}/${path}`;

async function storefrontQuery(p: ShopifyParams, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  return fetchJson(storefrontUrl(p), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": p.storefrontAccessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
}

export async function getProducts(p: ShopifyParams, first = 20): Promise<unknown> {
  return storefrontQuery(
    p,
    `query($first:Int!){ products(first:$first){ edges{ node{ id title handle description priceRange{ minVariantPrice{ amount currencyCode } } featuredImage{ url } } } } }`,
    { first },
  );
}

export async function getProductById(p: ShopifyParams, id: string): Promise<unknown> {
  return storefrontQuery(
    p,
    `query($id:ID!){ product(id:$id){ id title description handle variants(first:20){ edges{ node{ id title price{ amount currencyCode } } } } } }`,
    { id },
  );
}

export async function createCart(p: ShopifyParams): Promise<unknown> {
  return storefrontQuery(p, `mutation{ cartCreate{ cart{ id checkoutUrl } } }`);
}

export async function addLineItems(
  p: ShopifyParams,
  cartId: string,
  items: { merchandiseId: string; quantity: number }[],
): Promise<unknown> {
  return storefrontQuery(
    p,
    `mutation($cartId:ID!,$lines:[CartLineInput!]!){ cartLinesAdd(cartId:$cartId, lines:$lines){ cart{ id checkoutUrl } } }`,
    { cartId, lines: items },
  );
}

// Admin API (requires adminApiAccessToken)
export async function getOrders(p: ShopifyParams): Promise<unknown> {
  if (!p.adminApiAccessToken) throw new Error("adminApiAccessToken required for orders");
  return fetchJson(adminUrl(p, "orders.json?status=any&limit=50"), {
    headers: { "X-Shopify-Access-Token": p.adminApiAccessToken },
  });
}

export async function createWebhook(p: ShopifyParams, topic: string, callbackUrl: string): Promise<unknown> {
  if (!p.adminApiAccessToken) throw new Error("adminApiAccessToken required for webhooks");
  return fetchJson(adminUrl(p, "webhooks.json"), {
    method: "POST",
    headers: { "X-Shopify-Access-Token": p.adminApiAccessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook: { topic, address: callbackUrl, format: "json" } }),
  });
}

export async function testConnection(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const parsed = shopifySchema.safeParse(params);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  try {
    await withRetry(async () => {
      // A trivial Storefront query validates the token + domain.
      const res = await fetch(storefrontUrl(parsed.data), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": parsed.data.storefrontAccessToken,
        },
        body: JSON.stringify({ query: "{ shop { name } }" }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error("Invalid Storefront access token");
      if (!res.ok) throw new Error(`Shopify responded ${res.status}`);
      const json = (await res.json()) as { errors?: unknown };
      if (json.errors) throw new Error("Shopify returned GraphQL errors — check token scopes");
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const shopify: ProviderDef = {
  id: "shopify",
  name: "Shopify",
  category: "Database",
  emoji: "🛍️",
  description: "Fetch products, build carts/checkout and (with the Admin token) read orders & create webhooks.",
  schema: shopifySchema,
  fields: [
    { key: "shopDomain", label: "Shop Domain", type: "text", placeholder: "my-store.myshopify.com" },
    { key: "storefrontAccessToken", label: "Storefront Access Token", type: "password", placeholder: "shpsa_..." },
    { key: "adminApiAccessToken", label: "Admin API Access Token (optional)", type: "password", placeholder: "shpat_...", optional: true, help: "Needed for orders & webhooks." },
  ],
  testConnection,
  keywords: /\b(shopify|store|e-?commerce|product catalog|storefront|checkout)\b/i,
  promptRule: `SHOPIFY: the user connected a Shopify store. Generate code that uses the
Shopify Storefront GraphQL API (POST https://{shopDomain}/api/2024-10/graphql.json
with header X-Shopify-Storefront-Access-Token) for products/cart/checkout. Use
the Admin API (X-Shopify-Access-Token) ONLY in backend routes for orders &
webhooks. Read tokens from env in the backend; never expose the Admin token to
the frontend.`,
};
