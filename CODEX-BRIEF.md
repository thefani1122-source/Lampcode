# Work order for Codex — 2026-10-21

Paste this whole file to Codex. Nothing in it touches what Claude is working on.

## Do NOT touch (Claude is in these)

- `src/agents/build-classifier.ts` and `scripts/classify-corpus.test.ts`
- the classification block and the database gate in `src/server/routes/build.ts`
  (roughly: `classificationPromise` → `isFullstackBuild` → `DB_GATE_TIMEOUT_MS`)
- `src/mcp/supabase-mcp.ts`
- anything in the database path: `getUserSupabasePreviewCreds`, `applySupabaseSchema`,
  `DB_INSTRUCTIONS`

If one of the tasks below genuinely needs a line in those, say so and stop rather than editing.

---

## 1. Two process problems, before any code

Both of these happened in the last push and both cost real time to find.

**a) A red branch was pushed.** `scripts/mcp-connection.test.ts` was failing at `a064227`
("IPv6 loopback custom MCP URLs are rejected"). The case was right and the code was wrong — it
was a live SSRF bypass, now fixed in `a41b0ef`. Please run the full `npm test` before every push,
not a subset.

**b) An editor wrote lossy bytes.** `src/mcp/supabase-mcp.ts` line 6 came back with literal
U+FFFD replacement characters (`EF BF BD`) in place of the `──` box-drawing comment, and the same
commit (`fcb64a3`) silently deleted an unrelated line from `src/db/schema.ts`
(`browserOnlyPersistence`) while editing that file for another reason. Both are now restored.
Please write files as UTF-8 and diff each file you touch before committing.

## 2. A guard for the bug class that caused the SSRF hole (small, high value)

The bypass was this, in `src/mcp/connection.ts`:

```ts
hostname.toLowerCase().replace(/^\\[|\\]$/g, "")   // matches BACKSLASH + bracket
```

In a TypeScript **regex literal**, `\\[` is a backslash followed by `[`, not an escaped bracket.
Inside a `new RegExp(\`…\`)` template or a browser-script string, `\\b` is correct — so a naive
grep is noisy.

Write `scripts/regex-escapes.test.ts` that parses `src/**/*.ts` with the TypeScript AST, looks
only at **regular-expression literals**, and fails on any that contain `\\` immediately followed
by one of `[ ] ( ) . + * ? ^ $ | d w s b D W S B`. Allow an explicit `// regex-escape-ok` comment
on the line for the rare legitimate case. Add it to `npm test`.

## 3. P0.2 — `diff_since` erases real edits

Still open, and it is the reason the model rewrites whole files instead of editing them: it cannot
see its own change, so it takes the safe-looking path.

Reproduced 2026-10-17: four created files of ~11,000 lines plus a one-line edit →
`filesChanged=0, added=0, removed=0`, and the edit absent. One large file alone is fine. Cause: a
pure create or delete still runs Myers, spending the budget on a diff that needs no search and
starving every file after it.

Fix: when one side is absent, emit all-add or all-remove without calling Myers. Pin it with a
case built from that exact shape — several large creates plus one small edit, and the small edit
must appear.

## 4. The MCP OAuth flow is half-built — finish the user-visible half

The server side you wrote is sound (single-use state, hashed, 10-minute TTL, PKCE, encrypted
tokens, resource-origin check). It cannot be used yet:

- **`MCP_OAUTH_REDIRECT_URL` is not set on Railway**, so every OAuth connect answers 503. Document
  the exact value in `.env.example` and tell the owner what to set it to.
- **The frontend has no half.** `POST /api/integrations/mcp/:slug/oauth/start` returns an
  authorization URL and nobody opens it. `vibe-coder-suite` needs to: open that URL in a popup,
  wait for the callback to land, then re-read the connection list and show connected/failed. This
  is the "authorization page with permissions" the owner has been asking for — it is the provider's
  own consent screen, and this popup is the only thing missing.
- **A connected Vercel/Stripe/Sentry/Linear/Cloudflare entry stored under the old static-token
  flow is now dead for MCP** (their `authType` became `oauth`, so `resolveMcpAuth` looks for
  `oauth_access_token` and finds a `vercel_token`). The owner's Vercel connection from 16 Oct is in
  that state. Detect it and tell the user to reconnect, rather than returning a server with empty
  headers that fails discovery silently.

Note: `deploy_app`'s token is now read separately by `getUserVercelDeployToken` — that path is
fixed and is not part of this task.

## 5. Report, do not assume

For each task: what you measured before, what you changed, what the gates said, and what you could
not verify. If something here turns out to be wrong against the real code, say that instead of
working around it — more than one confident outside claim in this repo has turned out false.
