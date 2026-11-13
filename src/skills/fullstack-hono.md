---
name: fullstack-hono
description: React + Vite + Hono full-stack architecture for LampCode E2B previews, caller-JWT Supabase access, same-origin API routing, and safe runtime boundaries.
---

# Full-stack Build — React + Vite + Hono

This reference applies ONLY when the authoritative build context selects the React/Vite frontend with a Hono/Node backend. The main build prompt and provider-specific DATABASE section remain authoritative for required files, database choice, auth, and schema. Do not apply this Hono layout to Next.js Route Handlers, TanStack Start server functions, or Python/FastAPI builds.

## Runtime

- React/Vite frontend: port 5173.
- Hono/Node backend: port 3001.
- E2B runs both in the same sandbox.
- Vite proxies same-origin `/api/*` requests to the Hono backend on port 3001.
- Browser code calls `fetch('/api/...')` through a typed client module. Never hardcode localhost, 127.0.0.1, or an E2B hostname in frontend code.
- The backend listens on `Number(process.env.PORT) || 3001`.

## Architecture and file responsibilities

Follow the exact required file list and entry-point conventions in the current `FULLSTACK_INSTRUCTION`. In the standard new React/Hono path:

- `src/server/app.ts` creates and exports the Hono app without starting a listener.
- `src/server/index.ts` starts the app for the preview.
- `src/server/routes/api.ts` defines the app's API routes.
- `src/db/types.ts` and `src/db/schema.sql` describe the data model when required by the selected database.
- `src/lib/api.ts` provides typed browser-to-backend API functions.
- `src/App.tsx` and `src/index.tsx` implement the React application.

Do not generate template-owned files or replace the runtime's package/config files. Add auth files only when the user or authoritative build context requires authentication.

## Same-origin API calls

Use the Vite proxy in preview:

```ts
const API_BASE = import.meta.env.VITE_API_URL ?? "";

export async function getItems() {
  const response = await fetch(`${API_BASE}/api/items`);
  if (!response.ok) {
    throw new Error("Could not load items");
  }
  return response.json();
}
```

Do not convert an HTTP/database failure into `[]`, `null`, fake data, or a localStorage fallback. Preserve the distinction between a real empty result and a failed request so the UI can show a truthful error state.

## Supabase caller identity and RLS

When the selected database is Supabase, use the authoritative `DB_INSTRUCTIONS.supabase` in the system prompt:

- Create the server-side client per request using the anon key and the caller's forwarded Authorization token.
- Forward the caller's JWT so Postgres RLS evaluates `auth.uid()` as the actual user.
- Never use a service-role key as a shortcut around user-level authorization.
- Never trust a user_id supplied in the request body; derive actor identity from the authenticated request.
- Design policies for the real ownership/team model. Do not add `user_id` to every table automatically when the data is public, shared, or does not have an owner.
- Do not add a `service_role` GRANT. Only grant the minimum database privileges required by the intended client roles when the schema actually needs an explicit GRANT.

When the selected database is MongoDB, follow the MongoDB section instead. Do not mix Supabase clients, SQL/RLS instructions, or environment variables into a MongoDB build.

## CORS

The preview's frontend and backend are exposed through one same-origin Vite preview URL and `/api` proxy. Same-origin requests do not require permissive CORS. Do not add wildcard CORS by default.

Only configure CORS when the deployed architecture intentionally serves the API from another origin. In that case, use an explicit allowlist of configured origins, and never combine wildcard origins with credentialed requests.

## Error handling

- Validate request bodies and route parameters with Zod (or the selected backend framework's appropriate validator).
- Return correct HTTP status codes and safe, generic client-facing errors.
- Log diagnostic details server-side without returning stack traces, SQL errors, or secrets to the browser.
- Never return HTTP 200 with an empty array when a database query failed.
- Never claim persistence, authentication, or an integration works without evidence that the real service is connected and the request succeeds.

## Production and preview boundaries

- Keep secrets server-side. Only explicitly public browser variables may use the `VITE_` prefix.
- Do not generate `.env`; the preview runtime injects configured environment variables.
- Use the real backend as the source of truth for server-backed data.
- For an unconfigured or unavailable database, preserve the selected architecture and show an honest unconfigured/error state. Do not silently downgrade to mock data or browser storage.
