---
name: secure-generation
description: Detailed secure-by-design implementation guidance for applications with accounts, private data, APIs, databases, authentication, authorization, uploads, payments, multi-tenancy or external integrations.
---

# Secure Generation

Load this skill when the requested product or code change handles users, private data, privileged actions, APIs, databases, integrations, uploads, payments or multi-tenant access. Apply controls proportionate to the actual product; do not add an unnecessary login wall to a genuinely public app.

## Threat model before implementation

Identify the actors, roles, sensitive data, trust boundaries, privileged operations and likely abuse cases. Decide which routes/actions are public, authenticated, role-restricted or tenant-scoped. Record assumptions rather than inventing a business policy.

## Identity and authorization

- Authenticate protected requests on the server.
- Authorize each protected read and mutation at the resource level. UI visibility and client-side checks are not authorization.
- Derive user identity, tenant and role from a verified server-side session/token. Never trust a request body's user_id, owner_id, tenant_id, role, price or permission as proof.
- For multi-tenant products, verify membership and scope every query and mutation to the authenticated tenant.
- Deny by default when identity, ownership, role or membership cannot be established.
- Preserve the current project's auth/session model unless the user asks to change it.

## Database security and integrity

- Use parameterized queries or safe ORM bindings; never concatenate untrusted input into SQL.
- Enforce invariants with appropriate foreign keys, unique constraints, check constraints and transactions.
- Use database row-level security where supported and write policies for the intended roles and operations. For systems without native RLS, enforce equivalent server-side access checks.
- Keep service/admin credentials server-side and out of browser bundles. Never use elevated credentials as a shortcut around per-user authorization.
- Avoid migrations that silently drop or rewrite user data. Explain destructive or incompatible migrations and provide safe rollback/backfill considerations.
- Test cross-user and cross-tenant access denial, as well as legitimate authorized access.

## Inputs, outputs and external services

- Validate untrusted inputs at the server boundary with strict schemas, bounds and allowlists.
- Encode output for its context; avoid unsafe HTML/script rendering and mass assignment.
- Protect uploads by type, size, path and storage ownership.
- Restrict CORS when credentials are involved; use appropriate security headers and CSRF protection for cookie-authenticated mutations.
- Rate-limit abuse-prone operations such as login, password reset, OTP, search, upload and payment.
- Verify webhook signatures and replay/expiry constraints.
- For server-side URL fetching, block loopback, private, link-local and metadata destinations; validate redirects and resolved addresses to reduce SSRF and DNS-rebinding risk.
- Use timeouts, bounded retries, idempotency where appropriate and safe error handling for third-party integrations.

## Secrets, sessions and logging

- Keep credentials in server-side environment variables or a secret manager. Any VITE_* or NEXT_PUBLIC_* value is public when compiled into browser assets.
- Never commit secrets or emit tokens, cookies, authorization headers, private keys or full payment details in logs/errors.
- Use appropriate expiry, rotation, revocation and secure cookie flags where cookies are used.
- Return non-revealing client errors while retaining redacted diagnostic details server-side.

## Tests and honest verification

- Test unauthenticated denial, cross-user/cross-tenant denial, wrong-role denial, forged identity fields, validation boundaries and legitimate allowed access.
- Use isolated test tenants/accounts. Never mutate real user records simply to prove a flow.
- Do not weaken/delete security controls or tests to make a check pass. Fix the underlying defect.
- State exactly which security properties were verified and which could not be verified. Never claim an application is unhackable.
