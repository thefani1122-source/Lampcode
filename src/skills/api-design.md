# REST API Design Patterns

## HTTP Verbs and Status Codes
| Operation      | Method | Success code |
|----------------|--------|--------------|
| Fetch resource | GET    | 200          |
| Create resource| POST   | 201          |
| Replace        | PUT    | 200          |
| Partial update | PATCH  | 200          |
| Delete         | DELETE | 200 / 204    |
| No body        | any    | 204          |

- Use `400` for validation errors, `401` for unauthenticated, `403` for unauthorized, `404` for not found, `409` for conflicts, `500` for unexpected server errors

## Error Response Shape
Always return a consistent error body:
```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```
Never expose stack traces, SQL errors, or internal IDs in error messages.

## Input Validation
- Validate all inputs at the route handler boundary before touching the database
- Reject unknown fields — do not silently ignore extra properties
- Use Zod schemas and return 400 with clear field-level messages on failure

## Auth Pattern (Hono)
```ts
// Check auth before ANY database work
const user = c.get("authUser");
if (!user) return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
```

## List Endpoints
- Always paginate: `?limit=20&offset=0` (or cursor-based for large datasets)
- Return total count alongside items: `{ items: [...], total: 123 }`
- Support filtering via query params; index the filtered columns

## Idempotency
- GET and DELETE must be safe to retry without side effects
- PUT is idempotent — repeated calls produce the same result
- POST is NOT idempotent — use a client-generated `idempotency-key` header if retries matter

## Naming Conventions
- Use plural nouns for resource collections: `/api/projects`, `/api/users`
- Nest sub-resources under their parent: `/api/projects/:id/members`
- Use kebab-case for multi-word paths: `/api/build-jobs`
- Keep verbs out of path names — use HTTP methods to express the action

## Response Consistency
- Wrap single resources: `{ project: {...} }`
- Wrap collections: `{ projects: [...], total: N }`
- Always include the full updated resource in mutation responses — never just `{ success: true }`
