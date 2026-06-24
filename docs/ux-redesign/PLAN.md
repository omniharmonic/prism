# Prism UX Redesign — "Blue Sky"

Branch: `design/notion-anytype-ux`
Status: **in progress** (started 2026-06-23)

A radical-but-non-destructive UX overhaul of Prism (desktop + web/PWA). The goal is a
clean, contemporary, professional feel — closer to **Notion** and **Anytype**
(github.com/anyproto/anytype-ts) — **without losing any existing functionality**.

## Hard constraints (non-negotiable)

1. **No functionality regressions.** Every renderer, command, store action, VaultClient
   call, collab feature, and Tauri/web transport must keep working. The redesign is a
   *skin + interaction* layer over the existing component graph, not a rewrite of data flow.
2. **Both shells.** Changes live in `packages/core` so desktop (Tauri) and web (PWA) both
   get them through the shared UI core. Shell-specific work (mobile drawer, safe-area
   insets) is additive.
3. **Incremental + reversible.** Land in small commits. The app must build and run after
   every commit. `main` is never touched.
4. **Mobile-responsive.** The web PWA must be genuinely usable on a phone (collapsible
   nav, touch targets ≥44px, safe-area aware, no horizontal scroll).

## Aesthetic direction — "Blue Sky"

A calm, airy, content-first surface. Restrained translucency (not heavy glass everywhere),
generous whitespace, refined typography, monochrome chrome with a single sky-blue accent.

- **Palette:** near-white / near-black neutrals with a cool undertone; one sky-blue accent
  (`--accent`) for active/interactive states. Everything else is grayscale. Dark mode is a
  true peer, not an afterthought.
- **Translucency ("frosted-lite"):** subtle `backdrop-blur` + low-opacity fills on *floating*
  surfaces only — sidebar, right panel, command palette, popovers, menus. Content surfaces
  are solid for readability. Keep the existing "glass" identity but lighter and more precise.
- **Typography-first:** Inter (or system stack) with a deliberate type scale, generous
  line-height, and a comfortable content measure (max-width) like Notion.
- **Spacing & rhythm:** 4px base grid; consistent radii (6 / 8 / 12 / full); soft, low shadows.
- **Hover-reveal affordances:** Notion-style — drag handles, `+` add buttons, row actions
  appear on hover; quiet by default.
- **Motion:** fast and subtle (120–200ms, ease-out); always honor `prefers-reduced-motion`.

## Design tokens (single source of truth)

All visual decisions flow from CSS custom properties defined once in `packages/core` and
themed by `[data-theme]`. No hard-coded colors in components. (Exact token file path TBD
after recon — see Phase 0.)

Token groups: color (bg/surface/overlay/border/text/accent + semantic), space scale,
radius scale, shadow scale, typography (family/size/weight/leading), blur, z-index, motion.

## Phases

- **Phase 0 — Recon & foundation** (in progress)
  - [x] Branch + cleanup
  - [ ] Map current styling system, layout architecture, build/PWA tooling (3 recon agents)
  - [ ] Decide token architecture against what exists (Tailwind vs CSS vars)
- **Phase 1 — Design system foundation**
  - [x] Token layer retuned to "Blue Sky" (palette, glass, shadows, motion) + light/dark.
        Kept every existing var **name** (zero breakage); added additive tokens:
        `--surface-hover/active/selected`, `--focus-ring`, `--content-measure`,
        4px `--space-*` scale, `--z-*` scale, `--radius-full`. Reduced-motion guard added.
  - [x] Glass flattened to "frosted-lite": blur reserved for floating surfaces, quiet
        `.interactive` row utility, hover utilities repointed to surface tokens, focus ring.
  - [ ] Primitive components (Button, Input, Menu/Dropdown, Tooltip, Modal, Tabs, etc.)
  - [ ] Document tokens + primitives (this folder)
- **Phase 2 — App shell**
  - [ ] Sidebar / navigation (collapsible; Notion/Anytype information density)
  - [ ] Top bar / tab strip
  - [ ] Right/context panel
  - [ ] Command palette polish
- **Phase 3 — Surfaces & renderers**
  - [ ] Document editor chrome (Notion-like page header, content measure)
  - [ ] Dashboard widgets
  - [ ] Other renderers (task, calendar, messages, graph, etc.)
- **Phase 4 — Mobile / PWA responsiveness**
  - [ ] Responsive shell (drawer nav, bottom bar), safe-area insets, touch targets
- **Phase 5 — Verification**
  - [ ] Full typecheck + build (both shells)
  - [ ] Manual run-through: no feature lost; visual parity with the baseline

## Anytype-feel north star (deep dive on anyproto/anytype-ts)

Concrete patterns to adopt, ranked by impact-for-effort:
1. **Object icons** — [DONE] full emoji picker (emoji-picker-react, lazy-loaded, native
   style, theme-matched) in the shared PageHeader: "Add icon" → pick → large emoji above
   the title; persists to metadata.icon. Works in both editors (DocumentRenderer +
   CollabDoc). Verified on :5180.
2. **Command palette as quick-capture/search** — Anytype's ⌘K is object search + create-by-type.
   Rebuild CommandBar: sectioned, icon-led, "search vault objects" + "create {type}".
3. **Back/forward navigation** in the top bar (history of opened objects).
4. **Sidebar widgets** — Favorites / Recent / Sets above the tree (Anytype's widget rail).
5. **Cover images** on objects (optional banner above the page header).
6. **Sets/Collections** ≈ our dashboards — align their chrome with the object aesthetic.
7. Soft, light, rounded, generous whitespace everywhere (ongoing via tokens).

## Progress log

- 2026-06-23: Branch created; merged branches pruned (local + remote). Recon agents
  launched. Plan drafted.
- 2026-06-23: Recon complete (design system, layout architecture, build/PWA tooling).
  Confirmed: fully tokenized system (Tailwind v4 `@theme` + CSS vars), `@prism/core`
  consumed as source so style edits hot-reload both shells. Phase 1 token + glass retune
  landed; web build green.
- 2026-06-23: Visual harness online — Playwright/chromium (scratch) + dev-only `/design-lab`
  route screenshotted in both themes. Foundation looks clean/airy in dark + light.
- 2026-06-23: **Decisions** (user): content font default = **sans** with a Notion-style
  in-editor **Sans/Serif/Mono** switch; deep-polish priorities = sidebar/nav, editor
  chrome, mobile/PWA, tabs+palette+panels (all four).
- 2026-06-23: Typography — content now defaults to sans via `--content-font` indirection
  (`[data-content-font]` override); added per-document FontSwitch in DocumentRenderer,
  persisted to `metadata.contentFont`. Core+web typecheck green. (TODO: mirror switch in
  CollabEditor + honor metadata.contentFont in ShareView.)
  Next surface: sidebar & navigation.
- 2026-06-23: **Real-app verification harness online.** Mint an owner session row in
  `apps/server/prism-server.db` → drive Playwright against the live gateway (:8787) with
  `prism_session` cookie + `localStorage["prism:onboarded"]=true` to skip onboarding →
  screenshot the real Shell with live vault data, both themes. (Scratch: `shotkit/shot-app.mjs`.)
  Confirmed the Blue Sky foundation is applied and looks clean/airy in the real app.
  NOTE: dev session id is prefixed `redesign-shot-`; delete it from the sessions table when
  the redesign work wraps. Do NOT rebuild apps/web/dist until the user approves deploying
  the redesign to the live tunnel — :8787 serves production.
- Next: deep polish, in order — (1) sidebar/nav density + hover-reveal, (2) tabs/palette/
  panels, (3) editor chrome (page header, block handles), (4) mobile/PWA drawer + touch.
- 2026-06-23: User feedback — "almost no difference, go MUCH deeper." Switched from
  token-only tweaks to **structural component redesign**. Also: 1420 (desktop vite in a
  browser) has no Tauri runtime → no vault data; added a dev-only web proxy
  (PRISM_DEV_SESSION) so `localhost:5180` serves the REAL app with live data + HMR.
- 2026-06-23: **Shell redesign pass 1** — Navigation: workspace header (gradient "P" brand
  mark), icon-led nav rows via `.interactive`, hover-revealed row/section actions, rotating
  chevron section header, prominent accent-tinted "New" button. TabBar: rounded icon
  buttons + refined tab pills (active = surface-active, dirty dot, hover-reveal close).
  Canvas EmptyState: Compass icon tile + cleaner heading/hint. Core typecheck green.
- 2026-06-23: **Shell redesign pass 2** — ProjectTree rows now use quiet `.interactive`
  hover + rounding, theme-aware selected state (was hard-coded bg-white/10), 28px height,
  tighter indent. DocumentRenderer gains a Notion-style page header (breadcrumb + large
  sans title) with generous content padding. Verified on real app (:5180): tree rows +
  selected highlight + tab pill all clean. Commits through 1bda0b1; core+web typecheck green.
- **Finding:** shared/collab-capable notes render via `CollabEditor` (CollabDoc path), NOT
  DocumentRenderer — so the page header + per-doc font switch must be mirrored there to be
  universal. TODO list:
  - [x] **Unified editor chrome.** Extracted PageHeader + FontSwitch into a shared
        `DocumentChrome` module (exported from @prism/core); used by BOTH DocumentRenderer
        and the web collab host (CollabDoc). Collab documents now drop the bordered card
        (full-bleed, self-centering at --content-measure) and show the same breadcrumb +
        filename title + font switch + status/presence/comments in one header row. Verified
        on real app (:5180): collab "demo" doc matches the plain document view. core+web
        typecheck green.
  - [x] **Dev access fixed.** Proxy now injects the owner session on the /collab WS upgrade
        and Set-Cookies it, so collab-capable notes (most notes) open on localhost:5180.
  - [x] **Editable title → rename.** PageHeader title is now click-to-edit (Enter/blur commits,
        Esc cancels), shared by both editors. `renamePath()` swaps the filename base (preserves
        folder + extension); DocumentRenderer commits via useUpdateNote + renameTab, CollabDoc
        via REST updateNote (provider-free, also works on the share route) + renameTab. Gated to
        editors (canReview). Verified on :5180. core+web typecheck green.
  - [x] Desktop collab host (DesktopCollabDocument) — now uses the shared DocumentChrome
        (PageHeader + breadcrumb/title, editable rename, emoji icon, FontSwitch, status +
        comments in header). Desktop typecheck green. Honor metadata.contentFont in ShareView (TODO).
  - [x] Persist collab FontSwitch choice to metadata (web CollabDoc REST + desktop useUpdateNote).
  - [x] Command palette (⌘K) Anytype refresh — .interactive rows, object emoji icons, section
        labels, keyboard-hint footer, responsive width.
  - [x] Mobile reviewed (phone viewport): drawer + redesigned sidebar + empty state + top bar all
        translate cleanly with generous touch targets. Minor: empty-state ⌘K hint is desktop-centric.
  - [x] **Wikilink navigation fix.** The collab editor wired `onNavigate` to a no-op, so
        clicking `[[links]]` did nothing (most docs are collab). Added a shared
        `useWikilinkNavigate()` hook (also fixes a `vault/`-prefix resolution gap), exposed
        `onWikilinkNavigate` on CollabEditor, and wired it in the in-app seam (web + desktop)
        and DocumentRenderer. Verified: clicking a link opens the target in a tab.
  - [x] **Share-link access flow.** Recipients can click between linked docs (CollabPage routes
        to the target's page carrying the capability token); a clean "Request access" page shows
        when the gateway denies access. (Caveat: recipient path→id resolution is best-effort —
        a granted target opens; otherwise request-access. Owner in-app navigation is solid.)
  - [x] Back/forward object navigation in the top bar — useUIStore nav history (push on
        openTab/setActiveTab, skip closed tabs), ChevronLeft/Right buttons with disabled states.
        Verified: A→B→C, Back→B, Back→A, Forward→B.
  - [ ] Sidebar widgets (Favorites / Recent) above the tree.
  - [ ] Command palette (CommandBar) visual refresh.
  - [ ] Context panel (metadata/links/history/graph tabs) refresh.
  - [ ] Mobile/PWA: drawer, bottom affordances, touch targets, safe-area.
