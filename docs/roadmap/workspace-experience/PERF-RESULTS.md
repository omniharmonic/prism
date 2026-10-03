# Performance results (NP-PF-01…09, NP-SB-13)

Group 3C, branch `feat/w5-a11y`, measured 2026-10-03. Budgets are the ones in
`NOTION-PARITY-CHECKLIST.md` §2.14 and row NP-SB-13.

## Summary

| Row | Budget | Result (best of 5 / median) | Verdict |
|---|---|---|---|
| NP-PF-01 desktop, warm HTTP cache | ≤ 2.0 s | **419 / 427 ms** (was 517 / 563) | pass on loopback; see caveats |
| NP-PF-01 iPhone | ≤ 3.0 s | proxy only: 1,172 / 1,200 ms (was 1,428 / 1,444) | **not measured on a device** |
| NP-PF-02 cached | ≤ 300 ms | ⌘K 65 / 80 ms · tree 60 / 68 ms | pass |
| NP-PF-02 uncached, 50 KB | ≤ 1.0 s | 185 / 204 ms | pass on loopback |
| NP-PF-03 keystroke to paint, p50 | ≤ 16 ms | 13.1 / 13.2 ms | pass, close to the limit |
| NP-PF-03 long tasks > 50 ms | none | none in 375 keystrokes | pass |
| NP-PF-04 tree render | ≤ 500 ms | 132 / 205 ms | pass |
| NP-PF-04 scroll | 60 fps | 60 / 60 fps with 3,018 rows | pass (headless) |
| NP-PF-05 titles / recents | ≤ 150 ms | open 25 / 49 ms · title 6 / 10 ms | pass |
| NP-PF-05 server full-text | ≤ 500 ms | 238 / 257 ms in the UI · server p95 9.9 ms | pass; vault time not included |
| NP-PF-06 first paint, 5k rows | ≤ 1.5 s | 662 / 702 ms | pass |
| NP-PF-06 filter or sort | ≤ 500 ms | sort 41 / 49 ms · search filter 385 / 391 ms | pass |
| NP-PF-06 scroll | 60 fps | 60 / 60 fps | pass (100 rows in the DOM) |
| NP-PF-07 iOS memory | ≤ 300 MB, no growth | web proxy: 60.8 MB JS heap after 50 opens, flat | **device-only, not measured** |
| NP-PF-08 initial JS | ≤ 600 KB gzip | **417.1 KB** (was 754.6 KB, 972.1 KB before that) | pass (branch `feat/w6-perf`) |
| NP-PF-09 idle clients | no polling storm | browser 12 req/min for 3 tabs; server → vault 92 calls/min | browser side fine; **vault side is not at baseline** |
| NP-SB-13 new page | < 300 ms | **99 / 109 ms** (was 257 / 319) | pass (was a miss on the median) |

What still misses, and why:

1. ~~NP-PF-08~~ fixed on `feat/w6-perf` (fix 3 below): 417.1 KB gzip.
2. **NP-PF-09, vault side.** The collab reconciler reads every open live document from the vault every 2 s. Design below; the fix is in `collab.ts`, which this group does not own.
3. **NP-PF-01 iPhone and NP-PF-07** need a device (Safari Web Inspector, Xcode Instruments).

## How it was measured

- **Build:** the production web build (`npx vite build` in `apps/web`, output `apps/web/dist`). No number below comes from the dev server.
- **Server:** the real Prism Server (gateway, tree projection, `/api/search`, `/api/query`, Hocuspocus) from `apps/server/test/fixtures/perf-server.ts`, with an in-memory database and an in-memory fake vault. It never touches the live vault.
- **Vault:** synthetic, 15,016 notes and 9.5 MB of bodies. 10,000 mixed notes shaped like the real vault (3,000 message threads in one folder, 2,200 emails, meetings, people, tasks, documents nested 2–5 levels), 5,000 database rows, a 50 KB page, twelve more 50 KB pages for "uncached" opens, and a 10,145-word page of 205 blocks.
- **Browser:** headless Chromium (Playwright), 1440×900, service worker blocked, everything except loopback refused. Timings are taken inside the page: the input event stamps the start, and the end is the first presented frame after the condition holds.
- **Samples:** 5 per number. The table gives the best and the median. The checklist asks for p50/p95 over 20 runs on a quiet machine; this is not that.
- **Machine load:** other agents were running. 1-minute load average was 2.5–3.8 during every recorded run (it was 9–25 earlier, and those runs were discarded).

Commands:

```bash
cd apps/web && npx vite build
PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts            # every row
PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts -g PF-04   # one row
#   PERF_RUNS=5  PERF_IDLE_S=300  PERF_SOAK_OPENS=50  PERF_OUT=<results.json>
node scripts/perf-bundle.mjs            # NP-PF-08: initial vs lazy JS, gzip
node scripts/perf-static-graph.mjs      # what the entry reaches statically (seconds, no build)
node scripts/perf-static-graph.mjs --why maplibre-gl

# server-side timings (start the fixture on a free port first; it prints its session id)
cd apps/server && APP_ORIGIN=http://127.0.0.1:5364 PERF_PORT=5364 \
  node --import tsx --env-file=.env.test test/fixtures/perf-server.ts
node --import tsx scripts/measure-api.ts --base http://127.0.0.1:5364 --session <id> --runs 20
node --import tsx scripts/measure-idle-clients.ts --base http://127.0.0.1:5364 --cookie "prism_session=<id>" --mode events
```

Results land in `apps/web/test-results/perf/results.json`. A budget miss does not fail the spec.

## What these numbers do not cover

Read every "pass" with these in mind.

- **Loopback, no network.** The browser and server are on one machine. Download time is close to zero, so the 2.4 MB first chunk and the 2.1 MB tree cost almost nothing here.
- **The Node server does not compress static files.** Only `/api/tree` is gzipped. The first chunk travels as 2.4 MB raw unless a proxy in front compresses it. Whether the production tunnel does was not checked.
- **The fake vault is an in-memory filter.** It has no SQLite, no full-text index and no per-note schema validation. Server timings are Prism's own overhead and a lower bound. The real vault has taken seconds for large lists.
- **Web fonts are blocked.** `index.html` links a Google Fonts stylesheet, which is render-blocking on a real cold load. It is not in any number here.
- **Headless Chromium at 60 Hz** with a software compositor. Frame rates say the main thread kept up, not that a real GPU did.
- **The build included the accessibility group's uncommitted edits** in the same worktree (ARIA attributes and CSS). They should not affect timing.
- **Web builds only.** Nothing was measured in the iOS app or in Safari.

## Per row

### NP-PF-01 — cold start to interactive editor

Open `/page/perf-50k` and wait until the live editor is editable and holds the 50 KB body.

| Case | Before (best / median) | After | Samples after (ms) |
|---|---|---|---|
| Empty HTTP cache, desktop | 535 / 577 ms | 455 / 493 ms | 455, 467, 493, 682, 753 |
| Warm HTTP cache, desktop (the budget) | 517 / 563 ms | 419 / 427 ms | 419, 425, 427, 429, 543 |
| iPhone proxy: 390 px Chromium, 4× CPU throttle, warm | 1,428 / 1,444 ms | 1,172 / 1,200 ms | 1,172, 1,193, 1,200, 1,209, 1,214 |

The iPhone line is an indication only. It is Chromium with a slowed CPU, not WebKit on a phone.

Boot traffic on the first load, before and after the fix below:

| | Before | After |
|---|---|---|
| API responses | 24 calls, 15.7 MB | 23 calls, 2.3 MB |
| Largest | `GET /api/notes?limit=50000&sort=desc` 13.4 MB | `GET /api/tree` 2.1 MB (266 KB gzip) |
| JavaScript | 3.2 MB raw | 2.4 MB raw |

Also seen: `GET /auth/me` is called 8 times during boot and the opened page is read 4–5 times (the server's 5 s read reuse absorbs most of it). Not fixed.

### NP-PF-02 — open a page

| Case | Budget | Best / median | Samples (ms) |
|---|---|---|---|
| Uncached 50 KB page from ⌘K (Enter to painted, editable body) | ≤ 1,000 | 185 / 204 | 185, 192, 204, 205, 234 |
| Cached page from ⌘K | ≤ 300 | 65 / 80 | 65, 76, 80, 91, 95 |
| Cached page from the tree | ≤ 300 | 60 / 68 | 60, 67, 68, 69, 77 |

Every document in the web app opens as a live collab document, so "uncached" includes the socket handshake and the server seeding the Y.Doc from the vault.

### NP-PF-03 — typing in a 10k-word, 200-block page

The page has 205 top-level blocks: callout, toggle, columns, table, attachment, embed, bookmark, table of contents, an inline database block, to-do list, code block and quote. It is the live collab editor against real Hocuspocus. 75 keystrokes per run at 45 ms spacing.

| Metric | Budget | Best / median of the 5 run p50s | All 375 keystrokes |
|---|---|---|---|
| Keystroke to next painted frame, p50 | ≤ 16 ms | 13.1 / 13.2 ms | p50 13.3, p95 20.4, worst 30.8 ms |
| Synchronous handling per keystroke, p50 | — | 11.8 / 11.9 ms | |
| Long tasks > 50 ms | none | 0 in every run | |
| Echo to a second tab on the same document | — | 15 / 24 ms | 2 of 10 samples were 130 and 611 ms |

This passes with little room. About 12 ms of each keystroke is synchronous work, which leaves 4 ms of a 60 Hz frame. A phone will not hold 16 ms on this page. The two slow echo samples are untrusted: both tabs share one browser process on a loaded machine.

### NP-PF-04 — sidebar tree

The tree renders folders collapsed and builds a folder's rows only when it is opened. It is not virtualised.

| Metric | Budget | Best / median | Samples |
|---|---|---|---|
| Tree data received to tree painted | ≤ 500 ms | 132 / 205 ms | 132, 144, 205, 323, 324 |
| Navigation start to tree painted, cold | — | 308 / 478 ms | |
| Open a folder of 3,000 pages | (≤ 500 ms) | 264 / 285 ms | 264, 284, 285, 295, 319 |
| Scroll with 3,018 rows in the DOM | 60 fps | 60 / 60 fps | p95 frame 16.8 ms, worst 33 ms |

`GET /api/tree` is 2,112 KB of JSON (266 KB gzip) and takes 14–23 ms on the server once the projection is built (116 ms to build). A repeat with `If-None-Match` is a 304 in under 2 ms.

No fix was needed. A folder much larger than 3,000 pages would pass 500 ms, since the cost is linear in rows; windowing the rows of an open folder is the answer if that happens.

### NP-PF-05 — ⌘K

| Metric | Budget | Best / median | Samples (ms) |
|---|---|---|---|
| ⌘K pressed to recents and commands painted | ≤ 150 | 25 / 49 | 25, 43, 49, 52, 58 |
| Title typed to matching title row | ≤ 150 | 6 / 10 | 6, 9, 10, 16, 18 |
| Last keystroke to server full-text rows | ≤ 500 | 238 / 257 | 238, 255, 257, 264, 269 |
| `GET /api/search`, seen from the browser | — | 26 / 38 | |
| `GET /api/search` server side, 20 runs | ≤ 500 | p50 6.4, p95 9.9 | |

The full-text number includes the 200 ms input debounce. The server figure is the gateway's own work over a fake vault that does a substring filter; the real vault's full-text time is not in it.

One behaviour seen while building the harness: after results first appear, the list is empty for a moment and then fills again (ranked results, then the blended list). Pressing Enter in that gap does nothing. Not investigated.

### NP-PF-06 — database with 5,000 rows

The table loads 100 rows per page and sorts, filters and searches on the server.

| Metric | Budget | Best / median | Samples |
|---|---|---|---|
| Navigation start to first 100 rows painted | ≤ 1,500 ms | 662 / 702 ms | 662, 685, 702, 726, 846 |
| Sort from the column menu | ≤ 500 ms | 41 / 49 ms | 41, 42, 49, 53, 60 |
| Search filter, last keystroke to filtered rows | ≤ 500 ms | 385 / 391 ms | 385, 388, 391, 396, 400 |
| Scroll | 60 fps | 60 / 60 fps | p95 frame 16.8 ms |

`POST /api/query` on the server, 20 runs each: first page p50 2.7 ms / p95 18.7 ms; sort 1.9 / 4.8; two-condition filter 1.7 / 4.4; search 3.1 / 5.1; a 500-row page 2.6 / 3.1. These are warm: the route keeps the tag's lean listing for 4 s, so the first query after that window pays one vault listing of 5,000 rows, which the fake vault makes cheap.

The scroll figure is for one page of 100 rows. Scrolling through all 5,000 after loading every page was not measured.

### NP-PF-07 — memory (device-only)

The row needs Xcode Instruments on an iPhone. That was not done.

Web proxy: JS heap in desktop Chromium after a forced GC, opening eight different pages in rotation (six 50 KB pages, the 10k-word page, the 50 KB page) through ⌘K.

| Page opens | 0 | 10 | 20 | 30 | 40 | 50 | +20 s idle |
|---|---|---|---|---|---|---|---|
| JS heap (MB) | 32.5 | 57.3 | 59.8 | 65.5 | 60.5 | 60.8 | 60.8 |
| DOM nodes | 1,004 | 2,311 | 2,311 | 6,689 | 2,311 | 2,311 | 2,311 |

The heap is flat after the first ten opens (−0.19 MB per open over the second half). The run took about 3 minutes, not 30. This is JS heap only: no process memory, no native WebKit memory, no iOS.

### NP-PF-08 — initial JavaScript

`index.html` loads a 1.4 KB loader that immediately imports the app chunk, so the app chunk is the initial JS.

| | Before | After |
|---|---|---|
| Initial JS, gzip | 972.1 KB | **754.6 KB** |
| Initial JS, raw | 3,223 KB | 2,425 KB |
| Budget | 600 KB | 600 KB — still a miss by 155 KB |

After the editor split (`feat/w6-perf`, fix 3): **417.1 KB gzip / 1,332 KB raw** (PWA build), 416.7 KB (native build). Pass, 183 KB under.

Lazy chunks, as the row asks:

| Feature | Lazy? |
|---|---|
| Database | yes (`DatabaseRenderer`, 22 KB gzip) |
| Canvas | yes (Excalidraw, 1,082 KB gzip in 4 chunks) |
| Graph | yes (355 KB gzip) |
| Map | **yes after the fix**; before it, maplibre-gl was in the initial chunk |
| Editor | **yes after fix 3**; before it TipTap, ProseMirror, Yjs and highlight.js were in the initial chunk |

What the entry reaches statically after the fix (`perf-static-graph.mjs`, minified KB, not gzip): layout components 247, renderers 186, react-dom 177, highlight.js 165, prosemirror-view 95, TipTap extensions in `lib/tiptap` 93, `@tiptap/core` 87, entities 75, database components 73, navigation 73, marked 70, yjs 64.

### NP-PF-09 — idle clients

Three tabs (a document, the database, a blank page), left alone after 15 s of settling.

| | 300 s run (before) | 120 s run (after) |
|---|---|---|
| Browser → server | 12 req/min: `GET /auth/me` ×45, `GET /api/notifications/unread` ×15 | 12 req/min, same mix |
| Server → vault | 91.6 calls/min: `GET /notes/:id` ×458 | 92 calls/min |

The browser side is quiet: no list is polled, and nothing reaches the vault from these requests. `/auth/me` is asked three times a minute per tab.

The vault side is not at baseline. Every call is the collab reconciler reading an open live document, body included, every 2 s. It scales with the number of open documents across all clients, and it never stops while a tab is open. See the design below.

`measure-idle-clients.ts` against the same server, 3 clients for 60 s: `events` mode 18 requests, `poll` mode 30.

### NP-SB-13 — new page

Sidebar "New page" click to an "Untitled" page with the title focused.

| | Best / median | Samples (ms) |
|---|---|---|
| Before | 257 / 319 | 257, 316, 319, 329, 411 |
| After | **99 / 109** | 99, 108, 109, 115, 133 |

The create invalidates every vault query. Before the fix that refetched and parsed the 13.4 MB full-vault list on the main thread.

## Fixes made

### 1. Live documents no longer fetch the whole vault with bodies — `6fc9753`

`apps/web/src/collab/CollabDocument.tsx` called `useNotes()` to feed the `[[` and `@` suggestion lists. For the owner that is `GET /api/notes?limit=50000&sort=desc`: every note with its content. It ran on the first document open and again after every list invalidation, including each remote change event while a document was open. It now uses the sidebar tree, which is already in memory.

| | Before | After |
|---|---|---|
| API bytes at boot | 15.7 MB | 2.3 MB |
| Cold start, warm cache (median) | 563 ms | 427 ms |
| iPhone proxy (median) | 1,444 ms | 1,200 ms |
| New page (median) | 319 ms | 109 ms |

On a real network and the real vault the difference is larger than on loopback: this is the same full-vault list that stalled the vault on 2026-09-30.

**Behaviour change, since fixed (`53798f3`):** the tree carried a page's path, tags, type and icon, not `metadata.title` or `aliases`, so `[[` and `@` suggestions in a live document matched a page by its path name only. The tree projection now carries `title` and `aliases`, and both suggestion lists match them again.

The plain editor (`DocumentRenderer.tsx:85`) still calls `useNotes()`. The web app does not use it for the owner's documents; the legacy desktop does. Left alone because that file is a shared hotspot.

### 2. maplibre-gl out of the initial chunk — `d931613`

`packages/core/src/index.ts` exported `CommonsMap` statically, and `main.tsx` imports the barrel, so maplibre-gl (778 KB minified) was in the first chunk even though every map surface is lazy. The export is removed, `@prism/core/map` is a new package subpath, and the two publication templates import it lazily from there.

Initial JS: 972.1 → 754.6 KB gzip.

### 3. The block editor out of the initial chunk — `feat/w6-perf`

Design A below, built. Initial JS **754.6 → 417.1 KB gzip** (2,425 → 1,332 KB raw). The static set went from 2,765 modules / 2,516 KB minified to 2,384 / 1,432 KB (`perf-static-graph.mjs`).

What changed:

- `@prism/core/shell` (`packages/core/src/shell.ts`) is the old barrel minus the six exports that load the editor (`CollabEditor`, `CommentsSidebar`, `HumanSuggestionComposer`, `PresenceAvatars`, `PageDiscussion`, `MentionNode`). `@prism/core` (`index.ts`) re-exports the shell and adds those, so the legacy desktop, the fixtures and `CollabDoc.tsx` are unchanged. Every `apps/web/src` module except `CollabDoc.tsx` imports the shell.
- `COLLAB_SCHEMA_VERSION` lives in `editor/schemaVersion.ts` (no imports; `collabSchema.ts` re-exports it, value still 5). The request header and the background sync need the number at boot.
- `main.tsx`: the live editor goes through `collab/lazyCollab.tsx`; `ShareView`, `PublicationView`, `CollabPage`, `CommonsLanding` are `import()`ed on their routes.
- `collab/unsynced.ts` (on the boot path for the sync badge) no longer imports Yjs: storage and purges are `localDocumentStore.ts`, the headless push is `unsyncedSync.ts`, loaded only when a document is waiting. `localDocument.ts` re-exports the storage half, so its callers are unchanged.
- Guard: `npm run check:initial -w @prism/web` fails if TipTap, ProseMirror, Yjs, the socket provider, highlight.js, maplibre or Excalidraw become statically reachable from the entry. `perf-static-graph.mjs` gained `--edges`, `--frontier`, `--from … --reaches` and `--assert-lazy`.

Loading the editor chunk:

- A `/page/<id>` link starts the download at the top of `start()`, in parallel with `/auth/me`.
- Otherwise it is fetched when the browser is idle (≤ 3 s after boot) or at the first key or pointer press.
- Once the chunk is in, a document mounts the editor directly, with no Suspense boundary, so there is no loading state for a chunk the browser already has. An open that beats the download shows "Opening document…", the same line the editor starts with.
- The service worker still precaches the editor chunks, so a live document opens offline as before.

Timings on the new build (same harness, 5 samples, load 2.6–3.9):

| Row | Before (best / median) | After | Samples after (ms) |
|---|---|---|---|
| NP-PF-01 empty cache | 455 / 493 ms | 448 / 496 ms | 448, 476, 496, 701, 739 |
| NP-PF-01 warm cache | 419 / 427 ms | 371 / 525 ms | 371, 449, 525, 598, 614 |
| NP-PF-01 iPhone proxy | 1,172 / 1,200 ms | 1,014 / 1,055 ms | 1,014, 1,017, 1,055, 1,103, 1,184 |
| NP-PF-02 uncached from ⌘K | 185 / 204 ms | 179 / 185 ms | |
| NP-PF-02 cached from ⌘K | 65 / 80 ms | 76 / 78 ms | |
| NP-PF-02 cached from the tree | 60 / 68 ms | 56 / 66 ms | |

The warm-cache median is worse and noisy (371–614 ms); the best sample is better. Not explained; the machine was shared. Without the early download on a page link the same row was 504 / 858 ms, so that step matters.

Not measured: a first document open from Home on a slow network before the idle download has finished. It shows "Opening document…" until the chunk arrives.

Still in the initial chunk and movable later: `marked` (70 KB minified; `EmptyPageStarters`, `ShareView`'s share, the Tauri shim, native extras), `entities` (75 KB, through `lib/wikilinks.ts`), `turndown`, `dompurify`.

## Designs, not built

### A. Editor out of the initial chunk (NP-PF-08) — BUILT, see fix 3

The remaining 155 KB cannot come from small moves. Estimated gzip savings: highlight.js about 50 KB, the editor stack as a whole (ProseMirror, TipTap, Yjs, y-tiptap, Hocuspocus provider, highlight.js, linkify, `lib/tiptap`, the editor renderers) about 300 KB. Lazy-loading the editor would put the initial JS near 455 KB.

The obstacle is the `@prism/core` barrel. `apps/web/src/main.tsx` imports it, and it re-exports modules that import the editor: `collabSchema.ts`, `PresenceAvatars.tsx` (through y-tiptap), `CollabEditor`. `main.tsx` also imports `CollabDocument`, `ShareView`, `CollabPage` and `PublicationView` statically.

Steps:

1. In `main.tsx`, make `CollabDocument`, `CollabPage`, `ShareView`, `PublicationView`, `CommonsLanding` and `GovernancePanel` `React.lazy`. Each is a separate route or is only rendered once a document opens.
2. Move the editor exports out of the barrel into a subpath (`@prism/core/editor`), as was done for the map. `@prism/core/editor-schema` already exists for the server.
3. Find every remaining static path with `node apps/web/scripts/perf-static-graph.mjs --why prosemirror-view` and cut it. Known ones: `PresenceAvatars`, `MentionView`, `mediaViews`, `findShortcuts` users in the shell.
4. Verify with `perf-bundle.mjs`, then re-run NP-PF-01: a document page then needs a second chunk before it is editable, so preload the editor chunk when the first tab is a document.

Cheaper partial step if the full split waits: register highlight.js grammars after load (`createLowlight()` empty, then `import("lowlight")` for `common`), about 50 KB gzip. It needs a transaction to redraw code blocks once the grammars arrive, and `blocks.ts` is shared with the server.

Risk: the barrel has many consumers and the accessibility group was editing the same files, so this was not started.

### B. Reconciler without a vault read per document every 2 s (NP-PF-09)

`startReconciler` in `apps/server/src/collab.ts` runs every 2 s and calls `getNote` for each loaded, connected document to compare the vault's `updatedAt` with its baseline. With 2–3 documents open that is 92 full-body reads a minute, all day.

The tree projection already holds each note's current `updatedAt`, kept live by the vault's subscribe socket and by gateway write-through. Proposed change: on each tick, look the note up in the projection and call `getNote` only when the projection's `updatedAt` is newer than the reconcile baseline. Fall back to today's read when the projection has no live socket (the state the tests and this fixture run in), at a slower interval such as 15 s. Expected idle cost: zero vault calls while the socket is live.

Not built: `collab.ts` is outside this group's files.

### C. Paged tree (`/api/tree?prefix=`)

Not required by any budget today. The whole tree is 266 KB gzip and renders in about 200 ms at 15k notes. It becomes worth building when phone parse time for the 2.1 MB JSON shows up in a device measurement, or the vault passes roughly 50k notes. Shape: `GET /api/tree?prefix=<folder>&depth=1` returning that folder's rows and child-folder counts, with the client fetching a folder when it is expanded. The cost is that ⌘K title matching and the `[[` suggestions read the full tree today and would need a server title search.

### D. Smaller items

- Compress static assets in `app.ts` (`hono/compress` on `/assets/*`), or confirm the production proxy does. One line; not done because it changes nothing on loopback and could not be verified here.
- `GET /auth/me` eight times at boot and three times a minute per idle tab. Cache it for a few seconds in `fetchMe()`.
- Self-host the web fonts, or load the stylesheet without blocking render.

## Files

- `apps/web/playwright.perf.config.ts`, `apps/web/perf/harness.ts`, `apps/web/perf/pf.spec.ts`, `apps/web/tsconfig.perf.json`
- `apps/web/scripts/perf-bundle.mjs`, `apps/web/scripts/perf-static-graph.mjs` (`npm run perf | perf:bundle | perf:graph | check:initial -w @prism/web`)
- `apps/server/test/fixtures/perf-server.ts`, `apps/server/scripts/measure-api.ts`
- existing: `apps/server/scripts/measure-idle-clients.ts`
