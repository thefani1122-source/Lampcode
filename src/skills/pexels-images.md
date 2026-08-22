---
name: pexels-images
description: Real stock photos from Pexels for generated apps — direct client-side fetch to the Pexels Search API, required attribution, and the .env/README setup the user completes after generation.
---

# Pexels Images

Use this when a build needs real photos (hero images, product photos,
placeholder galleries, avatars-as-photos, background imagery) instead of
solid colors, gradients, or `picsum.photos`/`placeholder.com`-style filler.

## Where this runs

The generated app calls Pexels **directly from its own client code**, at
runtime, in the end user's browser — not through Lampcode's backend. Lampcode
never proxies this call and never holds a Pexels key of its own; the person
who owns the generated app gets their own free key and sets it in their own
`.env`, the same way they already do for `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY` in an auth build.

Pexels' API supports CORS and is designed to be called this way — the key is
read-only (it can only fetch photos, never modify or delete anything on the
account) and the free tier is rate-limited per key (200 requests/hour,
20,000/month), not billed. That combination — read-only, quota-limited
instead of dollar-billed, one key per project rather than a key Lampcode
would have to share across every generated app — is why a direct client-side
call is the right choice here, the same reasoning that already makes
`VITE_SUPABASE_ANON_KEY` safe to embed in this codebase's auth builds. It
does mean the key is visible in the deployed app's client bundle, so a
stranger could technically use it and eat into that project's monthly quota
— mention this plainly in the README section below rather than glossing
over it; don't treat it as a secret that must never be seen.

## Calling the API

```
GET https://api.pexels.com/v1/search?query=QUERY&per_page=15&page=1
Authorization: YOUR_API_KEY
```

Key query params: `query` (required), `per_page`, `page`, `orientation`
(`landscape` | `portrait` | `square`), `size` (`large` | `medium` | `small`),
`color`.

Response — each item in `photos[]`:
- `photographer` — name to credit
- `photographer_url` — link to the photographer's Pexels profile
- `url` — link to the photo's page on Pexels
- `src.large` (940×650), `src.medium` (proportional, 350px height),
  `src.small` (proportional, 130px height), `src.original` — pick the size
  that matches where you're placing the image; don't always reach for
  `original`.

Example client code:

```tsx
const res = await fetch(
  `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}`,
  { headers: { Authorization: import.meta.env.VITE_PEXELS_API_KEY } },
);
const { photos } = await res.json();
```

Read the key from `import.meta.env.VITE_PEXELS_API_KEY` — the `VITE_` prefix
is required for Vite to expose it to client code, same convention as
`VITE_SUPABASE_URL`.

## Attribution — required, not optional

Per Pexels' API guidelines: show a prominent link to Pexels, and credit the
photographer by name with a link to their profile whenever practical. Render
this as visible UI near the photo, not just in an alt tag or a footer buried
elsewhere:

```tsx
<a href={photo.url} target="_blank" rel="noopener noreferrer">
  Photo by {photo.photographer} on Pexels
</a>
```

Keep it small and unobtrusive (a caption line, a corner overlay on hover) but
it must actually be visible — don't omit it to keep a design "clean."

## README setup — same pattern as the Supabase auth README block

If the build includes Pexels images, add an "## Image Setup" section to the
generated `README.md` (create the file if this build doesn't already have
one). Match the style of the existing Supabase Auth Setup section exactly:

```
## Image Setup

1. Get a free API key at https://www.pexels.com/api/ (sign up, no credit
   card required)
2. Create a `.env` file from `.env.example` and add:
   ```
   VITE_PEXELS_API_KEY=your_key_here
   ```

> ⚠️ This key is visible in the deployed app's client bundle (required for
> the app to call Pexels directly from the browser). It's read-only and
> rate-limited to 200 requests/hour, 20,000/month on Pexels' free tier — if
> this app gets heavy traffic, consider proxying image search through your
> own backend instead.
```

Do not skip this section — without it, the deployed build shows broken
images the first time someone runs it without a key configured.
