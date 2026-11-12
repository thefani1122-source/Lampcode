---
name: database-rls
description: Provider-neutral database security guidance — ownership, tenant isolation, least privilege, safe queries, authorization boundaries, and tests for SQL and NoSQL data stores.
---

# Database Security & Data Isolation

These rules apply to SQL and NoSQL databases. They describe security properties, not a vendor-specific schema. Use the configured provider's native authorization and query mechanisms; never assume Supabase, `auth.uid()`, PostgreSQL syntax, or a particular ORM unless the project actually uses it.

## 1. Establish the authorization boundary

- Authenticate the caller before accessing private data.
- Authorize every read, create, update, and delete at the object/record level. Hiding a button or route is not authorization.
- Derive the acting user and tenant from the verified server-side session/token. Never trust a client-supplied `userId`, `ownerId`, `role`, or `tenantId` as proof of access.
- Scope every query to the authenticated principal and, for multi-tenant systems, to a verified membership in the tenant.
- Deny by default when identity, ownership, membership, or role cannot be established.
- Keep privileged credentials and service keys on the server. Never bundle them into browser code or expose them in logs.

## 2. SQL databases

- Where the provider supports row-level security, enable it on tables containing private or tenant-owned records and add policies for each required operation.
- Enforce ownership in the database as well as in the API when the provider supports it; do not rely on frontend filtering.
- Use parameterized queries or the ORM's parameter binding. Never concatenate untrusted values into SQL.
- Use foreign keys and unique constraints for invariants the database can enforce.
- Apply least-privilege grants: the application role should receive only the operations it needs.
- Add indexes for ownership and tenant columns used by authorization filters.
- For providers without native row-level security, enforce the same isolation in the trusted server/data-access layer.

## 3. Document and key-value databases

- Include ownership and tenant constraints in every query that reads or mutates private documents.
- For updates and deletes, combine the record identifier with the verified owner/tenant predicate; do not fetch by identifier and mutate without an authorization check.
- Set ownership fields from the authenticated server-side context when creating records.
- Validate document shape and allowed fields. Prevent mass assignment of owner, tenant, role, and billing fields.
- Use the provider's native access controls and least-privilege credentials. Do not assume that an application-level filter alone protects direct database access.
- Add indexes for frequently used ownership/tenant predicates and apply transaction or conditional-write semantics where concurrent updates matter.

## 4. API and application boundaries

- Keep authorization in a shared server/data-access boundary so every route uses the same checks.
- Separate authentication (who is calling) from authorization (what that caller may do).
- Validate input on the server and allowlist fields that callers may create or update.
- Return non-revealing errors for records the caller cannot access; do not leak whether another tenant's record exists.
- Never silently fall back from a real database to localStorage, hard-coded data, or an in-memory stand-in when a connection fails. Report the failure instead.

## 5. Security tests required for private data

Test the real persistence/authorization boundary, not only helper functions:

1. An unauthenticated caller cannot read or mutate protected records.
2. User A cannot read, update, or delete User B's records by guessing an identifier.
3. A member of Tenant A cannot access Tenant B's records.
4. A caller cannot assign themselves an elevated role or another user's ownership.
5. Each supported create/read/update/delete operation enforces the same ownership rule.
6. A database or authorization failure does not return a successful empty-data response that looks like a valid empty state.

Use an isolated test database or test tenant. Never mutate a live user's records to prove isolation.

## 6. Provider-specific rules

- For Supabase/PostgreSQL Auth, load and follow the dedicated `supabase-rls` skill for exact SQL, grants, and policy syntax.
- For MongoDB/Mongoose, use the project's existing schema, indexes, connection handling, and query conventions; do not add PostgreSQL RLS statements.
- For an existing project, inspect and preserve its actual provider and authorization model before proposing migrations.
