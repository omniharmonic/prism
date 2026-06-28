# Publishing Public Wikis

Prism can turn a **tag** into a public, read-only website — a "Wiki" of every note
carrying that tag. This is the anonymous path: no sign-in, no session cookie, no vault
token ever reaches the browser. It reuses the exact same authorization spine as the
gateway (`effectiveLevel` is the only guard); the tag merely *narrows* what's fetched.

Source of truth: `apps/server/src/routes/publish.ts` (public read path) and
`apps/server/src/routes/acl.ts` (owner management). For the security model overall, see
[`CLAUDE.md`](../CLAUDE.md) → *Prism Server & Web Sharing*.

---

## Publishing a tag

Two equivalent ways:

- **Share dialog → Publish tab.** In the app's Share dialog, the Publish tab appears for
  a note when a publishable tag is in play; it calls the owner endpoint below.
- **API (owner-only).**

  ```bash
  curl -X POST https://prism.example.com/acl/tags/<tag>/publish \
    -H 'Content-Type: application/json' \
    --cookie '<owner-session>' \
    -d '{"template":"wiki","title":"My Wiki","slug":"my-wiki","password":"optional"}'
  ```

  All body fields are optional. `slug` defaults to a slugified tag; `template` defaults to
  `"wiki"`. The response is `{ slug, tag, url, count, passwordRequired }`, where `count`
  is the live number of notes the tag currently exposes.

Publishing does two decoupled things:

1. **Config** — upserts a `publications` row (slug ↔ tag, template, title, optional
   password hash). One publication per tag (v1); re-publishing the same tag is
   **idempotent** and reuses the existing slug.
2. **Access** — upserts the publication primitive: an
   `anyone / resource_type=tag / level=view` grant. This is what authorizes anonymous
   readers — the public route synthesizes an anon actor whose grants are exactly these.

### The public URL

The human-facing site is at **`/p/:slug`** (e.g. `https://prism.example.com/p/my-wiki`).
That URL is a **client (SPA) route** — it serves the app shell, which then fetches the
publication **data** from **`/api/p/:slug`** (manifest), `/api/p/:slug/notes/:id` (a
single note), and `/api/p/:slug/graph` (the scoped graph). Keep this distinction in mind:
`/p/*` is the page, `/api/p/*` is the JSON.

List your publications:

```bash
curl https://prism.example.com/acl/publications --cookie '<owner-session>'
```

---

## The dynamic-scope warning

Publishing a **tag**, not a fixed list, means the publication is **dynamic**: *any note
you tag later automatically appears on the public site*, and any note you untag drops off.
The `count` returned at publish time is a point-in-time snapshot — treat the tag itself as
the access boundary. Don't publish a tag you also use as a private working bucket.

---

## Optional password gate

A publication can be password-protected.

- **Set at publish:** include `"password":"…"` in the publish body.
- **Set/clear later (owner):**

  ```bash
  curl -X PUT https://prism.example.com/acl/tags/<tag>/publish/password \
    -H 'Content-Type: application/json' --cookie '<owner-session>' \
    -d '{"password":"new-secret"}'      # omit/empty password → clears the gate
  ```

### How it works

- The password is hashed at rest with **scrypt** (constant-time verify) — never stored in
  the clear.
- A visitor proves the password at `POST /api/p/:slug/auth`. On success the server sets a
  **per-slug, httpOnly unlock cookie** `pub_<slug>`, an HMAC-signed `{slug, exp}` token
  (signed with `CAPABILITY_SECRET`, 30-day TTL). No DB lookup is needed to verify it on
  later requests; it only proves "this slug was unlocked and not yet expired."
- The unlock cookie is an **additional** gate layered on top of the
  `effectiveLevel`/tag-membership checks — never a replacement.
- A locked publication's manifest returns its identity (`slug`, `title`,
  `passwordRequired`) but **withholds the nav** (`notes: []`, `homeNoteId: null`) and the
  graph/single-note routes return `401 locked`, so a locked site never leaks its
  structure.

> **REQUIRE HTTPS for password-protected sites.** The unlock cookie is marked `secure`
> only when `APP_ORIGIN` is `https://…`, and HSTS is https-only. Serving a password site
> over plain http would expose the password in transit and the cookie to downgrade. Run
> behind your TLS tunnel.

---

## Leak-proofing: wikilinks, backlinks, and the graph

The public surface is built **only** from the publication's own note set, so private
content can't leak through links:

- **Note set** — `publicationNotes()` lists notes under the tag and filters each through
  `effectiveLevel >= view`. The single-note route additionally requires the note to
  actually carry the publication's tag (so a reader can't pull an arbitrary note id by
  guessing).
- **Graph** (`/api/p/:slug/graph`) — nodes are the in-set notes only. Edges come from
  wikilinks (`[[target]]`), but an edge is emitted **only** when the target resolves to
  *another in-set note*. Any wikilink pointing outside the set is dropped, so no
  out-of-publication node or edge can ever appear.
- **Wikilinks / backlinks** in the Wiki template are scoped to the same in-set resolver,
  and self-loops are dropped.

---

## Unpublishing

```bash
curl -X DELETE https://prism.example.com/acl/tags/<tag>/publish --cookie '<owner-session>'
```

This deletes the `publications` row **and** removes the `anyone` grant — both the config
and the access are torn down, so `/p/:slug` and `/api/p/:slug` go to `404`.

---

## Gotcha: keep public data under `/api/*`

The PWA service worker's `navigateFallback` shadows any route not in
`navigateFallbackDenylist`. The publication **data** lives under `/api/p/*` precisely
because `/api` is already denylisted; the human `/p/:slug` page is *intentionally* a
client route that falls back to the SPA. **Never** move publication JSON to a new
top-level prefix (like `/p`) without adding it to the denylist — it would work under curl
but be silently shadowed in the browser. The automated guard
`apps/web/scripts/check-sw-denylist.mjs` (`npm run check:sw -w @prism/web`) enforces this.
