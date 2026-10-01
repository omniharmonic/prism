# Prism: many sources, one coherent workspace

R02 design brief and implementation reference. The vector master is `packages/core/src/components/brand/PrismMark.tsx`; `npm run build:brand -w @prism/web` deterministically exports SVG, PNG, ICNS and ICO assets. Native installation/rendering verification is still pending.

## Core mark

The user's direction is explicit: **many colored beams entering a prism, then one unified ray leaving it**. Keep that direction even though a familiar optics illustration often depicts the reverse. This is a symbol of connected context and collaboration, not a physics diagram that needs to dictate the product metaphor.

The existing identity uses a luminous spectrum/ray treatment (`prism-logo-nav.png`, `Prism_Logo_rays.png`, and related assets). Preserve that recognizable light/spectrum character. The triangle/cube-like marks in earlier generated interface mockups are placeholders, not approved replacements.

Create a clean vector master: a restrained prism silhouette, a small fan of distinct spectrum inputs converging through it, and one clearly unified output. Use solid geometry and controlled color rather than relying on a fuzzy glow. The larger wordmark/hero version can carry more rays; the smallest mark must remain recognizable with fewer strokes.

## Variants and real-size checks

| Variant | Use | Requirements |
| --- | --- | --- |
| Full spectrum mark + wordmark | Sign-in, about, large navigation/brand preview | Many-in/one-out direction clear; wordmark readable without glow |
| Compact mark | Sidebar, favicon, tab, compact app chrome | Readable at 16, 20, 24, and 32 px; optical simplification allowed |
| App tile | PWA/mobile/home screen and macOS app icon | Maskable safe zone; balanced light/dark surroundings; no cropped beams |
| Monochrome | Native tray, accessibility/high contrast, print | Same silhouette without color dependency |
| Loading/empty-state accent | Sparse product moments | Static default/reduced-motion alternative; no continuous rainbow distraction |

Produce precise SVG masters and deterministic raster/native exports. Generated images may help compare visual directions, but should not be the only source for tiny production icons. Verify all exports against the master, at actual size, in both themes and with platform masks.

## Interface application

Use a quiet neutral writing surface, strong text hierarchy, and a limited accent color for primary actions/focus. Reserve the full spectrum for the brand, a subtle entry point, or a considered moment; do not turn each toolbar and panel into a rainbow. Person/channel/avatar colors have functional meaning and must remain distinguishable from agent identity and status.

Define light/dark semantic tokens for background, raised surface, border, text/muted text, action, focus, selection, success, warning, error, suggestion insertion/deletion, and collaborator identity. Status and permission modes need labels/icons as well as color. Read-only, Suggested edits only, and Read/write controls use unmistakable words, not three unexplained colored dots.

Typography should prioritize long-form writing, readable code, comfortable line length, and clear UI density. Keep the content font and publication theme configurable rather than hard-coding the app's brand typography into all notes and published sites. Respect reduced motion, contrast preferences, keyboard focus, and zoom.

## Asset and surface inventory

R02 checks all current references before replacement:

- Shared navigation/header, login/onboarding, empty states, loading/offline screens, About and workspace settings.
- Web public mark/favicon, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, manifest and social/public fallback imagery where used.
- Thin-client app icons (`icns`, `ico`, PNG sizes), tray/menu bar template icon, quick capture, notifications, and installers/bundle metadata that display artwork.
- Legacy desktop assets needed for rollback/build consistency, without changing its runtime responsibility.
- Publication default branding and user-provided overrides; never replace a publication's chosen identity with the app logo implicitly.
- README/design gallery references and any app-store/release artwork already present in the repository.

Branding must not change package/bundle identifiers, device-token keychain service names, application origin, OAuth/PKCE callbacks, vault identity, or offline storage namespaces. Those are compatibility/security contracts, not visual assets.

## Design proof before implementation

Add a brand board showing the complete mark, compact/monochrome variants, icon masks, wordmark, light/dark UI application, and real-size comparisons with the existing brand. Update the document+agent mockup to show the three per-session permission modes. Add the newly scoped product screens to the gallery before their corresponding UI slices: People, Calendar/transcript match, configurable Boards, Canvas, Graph, guest/access management, Governance, Publishing, and Integrations.

Use fictional data in all boards. Label concept screens and nonfunctional controls clearly; do not imply an image proves a backend feature exists. The final UI should follow tested interaction contracts even when a generated concept contains attractive but impractical spacing or invented microcopy.
