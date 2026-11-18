---
name: nextjs-production
description: Next.js App Router production conventions — Server/Client boundaries, Route Handlers, data access, auth, caching, deployment and verification.
---

# Next.js App Router — production conventions

- Keep pages/layouts as Server Components by default. Add "use client" only to the smallest component that needs state, event handlers, browser APIs, animation or WebGL.
- Keep databases, credentials, server SDKs and privileged functions in server-only modules. Never pass a server client or secret through props to a Client Component.
- Put HTTP APIs in app/api/**/route.ts. Validate each request with Zod, authenticate/authorize on the server and return correct status codes. Never return empty 200s or raw internal errors.
- Server Components call server-only data-access functions directly. Client components use same-origin APIs or Server Actions.
- Use session-aware DB clients and RLS/tenant filters for protected data. Never trust user/tenant IDs submitted by the browser.
- Choose caching deliberately. Personalised data must not be shared across users; disable caching for user-specific or rapidly changing reads.
- Use Node runtime for native DB drivers and AI frameworks. Do not choose Edge runtime unless every dependency in the route supports it.
- Do not add a separate Hono server inside Next.js. Route Handlers are the backend. Hono remains a separate supported architecture for explicitly requested React/Vite API projects.
- Keep the project deployable with next build and next start; avoid provider-specific APIs in application code.
- Test Route Handlers/data access, then run typecheck, Vitest and real browser preview checks.
