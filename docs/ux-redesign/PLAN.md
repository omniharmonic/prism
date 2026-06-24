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
