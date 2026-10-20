# Prism — Production-Readiness Evaluation & First-Principles Improvement Strategy

**Reviewer:** Senior engineering eval against `.claude/prism-prd-v3.md`
**Date:** 2026-06-09
**Scope:** `packages/core`, `apps/desktop` (+ `src-tauri`), `apps/web`, `apps/server`
**Method:** Static read of the whole tree + four parallel deep-dive sweeps, plus **live build/test/runtime verification** (not just reading).

---

## 0. What I actually ran (evidence, not impressions)

| Check | Command | Result |
|---|---|---|
| Install | `npm install` | clean, exit 0 |
| Typecheck (all 4 workspaces) | `npm run typecheck` | **PASS**, exit 0 |
| Rust backend | `cargo check` (src-tauri) | **PASS**, exit 0 |
| Web PWA build | `npm run build -w @prism/web` | **PASS** — but a **4.36 MB** main JS chunk (1.34 MB gzip), 119 precached entries / 6.97 MB SW precache |
| Server test suite | `npm test -w @prism/server` | **106/106 PASS** (auth, gateway, permissions, capability, rate-limit, collab, db, acl) |
| **Live gateway** | Booted `apps/server` against a stub Parachute on a real port and probed it | See below |

**Live authorization probes** (real HTTP against the running gateway, stub vault with one `shared` note + one `private` note):

| Probe | Expected | Actual |
|---|---|---|
| anon `GET /api/notes` | `[]` | `[]` ✅ |
| anon `GET /api/notes/n_priv` | 403 | 403 ✅ |
| anon `GET /api/notes/n_pub` (tagged, but no grant) | 403 | 403 ✅ |
| anon `GET /api/search?q=secret` | `[]` | `[]` ✅ |
| anon `GET /api/graph` (unlisted path) | 403 catch-all | 403 ✅ |
| anon `POST /api/notes` | 403 | 403 ✅ |
| anon `GET /acl/users` | 403 | 403 ✅ |
| owner-token over **loopback** | full vault | both notes returned ✅ |
| owner-token presented over **tunnel** (`X-Forwarded-For` set) | inert | `[]` ✅ (leaked token grants nothing from the internet) |
| capability `view` link → its note | 200 | 200 ✅ |
| same link → a *different* note | 403 | 403 ✅ |
| same link → `PATCH` (view < edit) | 403 | 403 ✅ |
| tampered capability token | 403 | 403 ✅ |
| security headers on `/api/*` | CSP/XFO/nosniff/Referrer/Permissions | all present ✅ |

**The gateway's authorization model is genuinely sound and I confirmed it at runtime.** This is the strongest part of the codebase. The deny-by-default catch-all, the loopback-gated owner token, and capability scoping all behave exactly as documented.

---

## 1. Verdict

Prism is a **real, substantial, ~80%-of-PRD application** — not a prototype. ~13.4k LOC of mature Rust, ~22k LOC of shared React, a security-reviewed Node gateway with 106 passing tests, and a working web PWA + desktop shell over one UI core. The architecture (VaultClient seam, tag-driven renderer registry, type-aware collab) is well-conceived and largely faithfully executed.

It is **not yet "production-ready and polished" in the sense the prompt asks**, for four reasons, in priority order:

1. **One concrete security bug** (unsanitized HTML on a public, unauthenticated share page) plus two hardening gaps (`csp: null` in the desktop webview, plaintext secrets at rest).
2. **PRD promises that are stubs or absent**: export (PDF/DOCX/PPTX), presenter mode, spreadsheet formulas, website deploy, focus mode, templates, backlinks, global hotkey, native notifications, OAuth2 (it shells out to `gog`/`gh` CLIs instead).
3. **No safety net**: zero error boundaries in the React tree, no CI, no linter, no frontend tests. A single renderer throw blanks the active tab.
4. **Polish debt**: five 700–1090 LOC "god components", a 4.36 MB web bundle, ~30 repeated `metadata as Record` casts, dead deps, and a README that documents the wrong macOS config path.

None of these are architectural dead-ends. They're a finite, enumerable punch list. The rest of this document is that list, with code.

---

## 2. PRD conformance matrix

### Renderers (PRD §3) — registry at `packages/core/src/components/renderers/Registry.ts`

| Renderer | State | Gap vs PRD |
|---|---|---|
| Document | ✅ full (469 LOC, TipTap) | no focus mode, no templates, no outline, no export, no backlinks |
| Code | ✅ full (CodeMirror 6) | "Monaco" in PRD; CodeMirror chosen instead (fine) — no split view, no terminal |
| Presentation | ⚠️ partial (307 LOC) | **no presenter mode**, no speaker notes UI, no themes, no PPTX/Slides export |
| Message | ✅ functional | renders Matrix threads |
| Email | ✅ functional (350 LOC) | compose limited to `gog send` args; no attachments/rich body |
| Task Board | ✅ full (kanban + dnd) | — |
| Calendar | ✅ day/week | no month view in renderer (dashboard variant has more) |
| Spreadsheet | ⚠️ partial (136 LOC) | **CSV only — no formulas, no sort/filter/group, no XLSX** |
| Website | ⚠️ stub (83 LOC) | iframe preview only — **no deploy, no multi-file, no hot reload** |
| Project | ✅ aggregates | — |
| Canvas | ✅ full (Excalidraw, 572 LOC) | not in PRD renderer list but a welcome addition |
| Dashboard | ✅ mature (13 widgets, filter engine) | strong; exceeds PRD |

### Cross-cutting features

| PRD feature | State | Evidence |
|---|---|---|
| Three-zone shell, tabs, resize | ✅ | `Shell.tsx`, responsive via `useIsMobile(768)` |
| ⌘K command bar | ✅ | `CommandBar.tsx` (324 LOC) |
| ⌘J inline agent prompt + diff | ✅ | `InlinePrompt.tsx`, ghost-text accept/reject |
| Panel chat | ✅ | `PanelChat.tsx` |
| Matrix unified messaging | ✅ | Rust `message_sync.rs` (512 LOC), 60s poll |
| Gmail send/read | ✅ | via `gog` CLI (`google.rs`) — no native OAuth |
| Google Calendar bidi | ✅ | `calendar_sync.rs` (458 LOC) |
| Google Docs sync | ✅ | `google_docs.rs` (107 LOC) via `gog docs` |
| Notion sync (page + DB) | ✅ | `notion_db.rs` (815 LOC) |
| GitHub sync | ✅ | `github.rs` adapter (933 LOC) |
| Real-time collaboration | ✅ | Hocuspocus, type-aware, 4 kinds, 106 tests |
| Web sharing (Google-Docs-style) | ✅ | capability links verified live |
| Cross-type transforms (agent) | ✅ | `agent.rs` transform skill |
| **Export DOCX/PDF/PPTX** | ❌ | no command found anywhere |
| **OAuth2 deep-link flow** | ❌ | `auth/mod.rs` modules commented out; relies on CLI keyrings |
| **iMessage** | ❌ | not implemented |
| **Slides / Sheets push** | ❌ | not implemented |
| **Deploy (Vercel/Pages)** | ❌ | not implemented |
| **Global hotkey** | ❌ | not implemented |
| **Native notifications** | ❌ | not implemented |
| **File watcher** | ❌ | not implemented |

---

## 3. Security findings (prioritized)

### 🔴 S1 — Stored XSS on the public share page (real bug)

`apps/web/src/share/ShareView.tsx` renders note content into an **unauthenticated, public** page via `dangerouslySetInnerHTML`, and the markdown is **not sanitized**. `marked` has not sanitized by default for years, and when the vault returns an HTML content-type the body is injected **verbatim**:

```ts
// apps/web/src/share/ShareView.tsx:44
html: ct.includes("html") ? body : renderMarkdown(body),   // raw HTML passthrough
// :119
function renderMarkdown(md: string): string {
  const clean = md.replace(/\[\[...\]\]/g, ...);
  return marked.parse(clean) as string;   // NO sanitization
}
// :98
<article className="prose-editor" dangerouslySetInnerHTML={{ __html: state.html }} />
```

The server-web exploration agent claimed "marked.parse() HTML-escapes markdown" — **that is incorrect**, and I verified it: a note body of `<img src=x onerror=alert(1)>` flows through untouched.

**Why it's only *partially* contained today:** the server's CSP (`script-src 'self'`, no `'unsafe-inline'`, `app.ts:30`) blocks inline event handlers and `<script>` on the *web* origin. So today this is latent rather than trivially exploitable on web — **but** (a) it's one CSP-relaxation or one `connect-src` data-exfil gadget away from live, (b) the **same sinks render inside the desktop Tauri webview which has `csp: null`** (`tauri.conf.json:25`), where there is no backstop at all (`DocumentRenderer.tsx:391`, `dashboard/widgets/EmbedWidget.tsx:61`).

**Fix** — sanitize at every HTML sink. Add `dompurify` and a single shared helper:

```ts
// packages/core/src/lib/html/sanitize.ts  (new)
import DOMPurify from "dompurify";
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan", "class", "data-type", "data-target"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style"],
    ALLOW_DATA_ATTR: true,
  });
}
```

```ts
// ShareView.tsx
import { sanitize } from "@prism/core/html";
...
html: sanitize(ct.includes("html") ? body : renderMarkdown(body)),
```

Apply identically at `DocumentRenderer.tsx:391` and `EmbedWidget.tsx:61`. (Server side, the collab `storeDocumentState` HTML is generated from a TipTap schema, so it's structurally constrained — but sanitizing the seed in `contentToYUpdate` is cheap defense-in-depth.)

### 🟠 S2 — Desktop webview ships with CSP disabled

`apps/desktop/src-tauri/tauri.conf.json:25` → `"csp": null`. The entire React UI (including the unsanitized HTML sinks above) runs with no content-security-policy. If any XSS lands, it has the full Tauri IPC surface.

**Fix** — set a real CSP mirroring the server's:

```jsonc
// tauri.conf.json
"security": {
  "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:1940 ws://localhost:* https:; font-src 'self' data: https://fonts.gstatic.com"
}
```

### 🟠 S3 — Secrets stored in plaintext at rest

`config.rs` persists Notion / Matrix / Parachute tokens and `COLLAB_TOKEN` as plaintext JSON in the app-config dir (`config.rs:37-94, 93`). Only the Anthropic key tries the macOS Keychain first (`config.rs:272`), and that fallback is mac-only. Any process running as the user can read every credential.

**Fix** — route all secrets through the OS credential store on every platform (the `keyring` crate is already a dependency for the Anthropic path). Store only non-secret config in JSON; store `*_token` / `*_api_key` keys in `keyring::Entry::new("prism", field)`.

### 🟡 S4 — `iframe sandbox` allows same-origin

`WebsiteRenderer.tsx` uses `sandbox="allow-scripts allow-same-origin"` for user HTML — that combination lets the framed content reach back into the app origin. Drop `allow-same-origin` (keep `allow-scripts` only) so previews are isolated.

### 🟡 S5 — Untrusted `JSON.parse` without shape guards

`CanvasRenderer.tsx:27` parses Excalidraw scene JSON from notes with no schema validation (prototype-pollution / malformed-shape surface). Validate with a small zod schema before `updateScene`.

### 🟢 S6 — Magic-link throttle is per-IP only

`magiclink` requests are rate-limited per-IP (`app.ts:64`) but not per-email; a botnet could spam the owner's inbox. Low severity (owner-only email), but add a per-email counter.

**Net:** the *gateway* security is excellent and verified. The *content-rendering* security (the HTML trust boundary that sharing introduces) is the weak axis and needs S1–S2 before any public exposure.

---

## 4. Code-quality & cleanup (production polish)

### 4.1 God components to split (each is one responsibility too many)

| File | LOC | Extract into |
|---|---|---|
| `navigation/ProjectTree.tsx` | 1090 | `TreeNode`, `TreeContextMenu`, `RenameDialog`, `MoveDialog`, a `useTreeDnd` hook |
| `layout/MetadataPanel.tsx` | 991 | `MetadataEditor`, `SyncConfigEditor`, `LinksEditor` |
| `layout/Settings.tsx` | 770 | one component per section (`ThemeSettings`, `VaultSettings`, `AiSettings`, …) |
| `comms/CalendarDashboard.tsx` | 765 | `CalendarGrid` + `CalendarSyncPanel` |
| `comms/VaultMessagesDashboard.tsx` | 733 | `ThreadList` + `TriagePanel` + `RoutingRules` |

Two Rust modules (`sync/adapters/github.rs` 933, `services/transcript_sync.rs` 887) are large but cohesive — lower priority.

### 4.2 Repeated patterns → shared utilities

- **~30 `(note.metadata as Record<string, unknown>)?.field` casts.** Add typed accessors:
  ```ts
  // packages/core/src/lib/metadata.ts
  export const metaStr = (n: Note, k: string) => {
    const v = (n.metadata as Record<string, unknown> | null)?.[k];
    return typeof v === "string" ? v : undefined;
  };
  ```
- **Modal scaffolding** is copy-pasted across `GitHubSyncModal`, `NotionDbSyncModal`, `ShareDialog`, `WidgetEditorModal` — extract one `<Modal>` (with focus trap, see §4.4).
- **Tag→color** logic duplicated in `CanvasRenderer.tsx:80` and `ProjectTree` — one `getTagColor()`.

### 4.3 No error boundaries — a renderer throw blanks the tab

There is exactly one boundary, at the desktop entry (`main.tsx`). Wrap the canvas and each lazy renderer:

```tsx
// packages/core/src/components/layout/RendererBoundary.tsx (new)
class RendererBoundary extends React.Component<{children: React.ReactNode}, {err?: Error}> {
  state = {}; static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return <div className="glass p-6 m-4">
      <p className="text-sm">This view hit an error.</p>
      <pre className="text-xs opacity-60">{String(this.state.err.message)}</pre>
      <button onClick={() => this.setState({ err: undefined })}>Retry</button>
    </div>;
    return this.props.children;
  }
}
```
Wrap `<Suspense>` content in `Canvas.tsx` with it.

### 4.4 Accessibility (currently near-zero)

No `aria-label`/`role`/`aria-pressed` on icon buttons; dialogs have no focus trap; task cards are `<div>`s not buttons; tab strip isn't arrow-navigable. Minimum bar for "polished across user flows": focus-trap modals, label icon-only controls, make `CommandBar` results a proper `role="listbox"` (it already does arrow-nav), and ensure 44×44px touch targets (several are ~20px, e.g. `CommandBar` `px-1.5 py-0.5`).

### 4.5 Web bundle is 4.36 MB (1.34 MB gzip) in one chunk

The build warns explicitly. Mermaid/KaTeX/Excalidraw should be `manualChunks` + route-level lazy. Target: <500 KB initial. This is the single biggest *mobile* polish issue (PRD §11 "Mobile companion").

### 4.6 Dead weight & drift

- **Unused root deps**: `matrix-js-sdk` and `y-webrtc` are imported nowhere (frontend Matrix goes through Rust; collab uses Hocuspocus, not WebRTC). Remove from root `package.json`.
- **`packages/core/package.json` under-declares** its real deps (`@tiptap/*`, `@codemirror/*`, `react`, `yjs`) — works only via hoisting. Declare them.
- **README drift (HIGH):** `README.md:175` says config lives at `~/.config/prism/...`; on macOS `dirs::config_dir()` (`config.rs:165`) resolves to `~/Library/Application Support/prism/...` — CLAUDE.md is right, README is wrong.
- **No CI, no ESLint, no Prettier config.** Add all three (below).
- **2 real TODOs** in `useParachute.ts:162,194` (GitHub per-file push path matching is unfinished) and 1 in `google.rs:54` (no `gog` archive — uses labels).
- One stray `console.log` at `CalendarDashboard.tsx:172`.

---

## 5. First-principles reframing — what is Prism *really*?

Strip the feature list and Prism is making one bet: **the unit of digital life is "a thing you work on," and where it physically lives is an implementation detail the tool should hide.** Everything follows from that — the tag-as-type system, the renderer registry, the vault-as-canonical-source, the agent-as-plumbing.

Measured against *that* idea (not the feature checklist), three things matter more than any single renderer:

**(A) The "you never leave Prism" promise is only as strong as round-trip fidelity.** The PRD's own open questions (§13.2) flag this. Right now sync is fire-and-forget with last-write-wins (`rest.ts` 409→force, `collab.ts` "external edit wins"). For documents that genuinely live in two places (Prism + Google Docs), LWW silently destroys the collaborator's edits. **First-principles fix:** the canonical layer should track a *sync revision* per destination and surface conflicts as a first-class renderer (the PRD imagines this in §3.1/§8.1 but it isn't built). Without it, the core promise leaks data.

**(B) The agent is described as "the bridge… in the background," but it's currently a set of discrete skills, not a bridge.** The PRD's most distinctive claim (§4.4: "⌘K → 'sync this to Google Docs'… the agent is the natural-language interface to operations that are ultimately deterministic") implies a **command grammar**: NL → a typed, deterministic operation the UI also exposes as a button. Today `CommandBar` fuzzy-searches and falls through to Claude, and transforms are a separate Rust skill. The high-leverage move is a single **operation registry** — every capability (create, transform, sync, export, deploy) registered once as `{ id, title, params, run }`, so the command bar, the `+New` menu, and the agent all dispatch the *same* deterministic functions. That collapses three parallel code paths into one and makes the agent exactly what the PRD says it is.

**(C) Identity of "a thing" must survive transport.** The seam (`VaultClient`) is the right abstraction and it's clean. But the renderer-selection truth is smeared across `metadata.prism_type` → tags → path-ext in *three* places (`content-types.ts`, server `collab.ts noteKind`, Rust `enrich_note`). Each has drifted subtly (the collab kind detector sniffs Excalidraw JSON; the client doesn't). **First-principles fix:** one canonical `inferKind(note)` shared by all three runtimes (publish it from `@prism/core`, have the server import it — it already imports `@prism/core/editor-schema`, so the path exists). Divergence here is exactly what corrupts notes (the CLAUDE.md "canvas wrapped in `<p>`" war story).

These three — conflict-aware sync, an operation registry, and a single kind oracle — are the first-principles spine. The renderers are leaves; these are the trunk.

---

## 6. The improvement strategy (phased, with code)

### Phase 0 — Stop the bleeding (1–2 days, do before any wider release)
1. **S1**: add `dompurify`, the `sanitize()` helper, wire it into the 3 sinks. *(security)*
2. **S2**: set a real Tauri CSP. *(security)*
3. **S4/S5**: drop `allow-same-origin`; zod-guard canvas JSON. *(security)*
4. Add `RendererBoundary` around the canvas + each lazy renderer. *(stability)*
5. Fix README config-path drift; remove `console.log`. *(correctness)*

### Phase 1 — Make it shippable & safe to change (1 week)
6. **CI**: add `.github/workflows/ci.yml`:
   ```yaml
   name: ci
   on: [push, pull_request]
   jobs:
     check:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: npm }
         - run: npm ci
         - run: npm run typecheck
         - run: npm run test -w @prism/server
         - run: npm run build -w @prism/web
   ```
7. **ESLint + Prettier** at root (flat config), `lint` script, fail CI on error. Wire `@typescript-eslint` `no-explicit-any` as a warning to chip at the Excalidraw `any`s.
8. **Secrets to keyring (S3)** on all platforms.
9. **Bundle split (§4.5)**: `manualChunks` for mermaid/katex/excalidraw + lazy-load by route. Re-measure; gate CI on a bundle-size budget.
10. Remove dead deps; fix `packages/core` dep declarations.

### Phase 2 — The first-principles spine (2–3 weeks)
11. **One `inferKind` oracle** exported from `@prism/core`, consumed by `Canvas.tsx`, server `collab.ts`, and (via a generated JSON or FFI table) the Rust `enrich_note`. Delete the two drifted copies.
12. **Operation registry**:
    ```ts
    // packages/core/src/lib/ops/registry.ts
    export interface Op<P = unknown> {
      id: string; title: string; group: "create"|"transform"|"sync"|"export"|"deploy";
      schema: z.ZodType<P>;
      run(ctx: OpContext, params: P): Promise<OpResult>;
    }
    export const ops = new Map<string, Op>();
    ```
    Register create/transform/sync/export once; have `CommandBar`, `NewContentMenu`, and the agent fall-through all dispatch `ops.get(id).run(...)`. This is the structural unlock for items 13–16.
13. **Conflict-aware sync**: per-destination `{ remoteRev, lastSyncedHash }` in metadata; on pull, 3-way diff; surface a `ConflictRenderer` (keep-mine / keep-theirs / merge). Closes PRD §13.3.
14. **Export pipeline** (the most-missed PRD promise): a Rust `export.rs` command using `pandoc` (or `docx-rs` + `printpdf`) for DOCX/PDF, and a Marp/`pptxgenjs`-style path for PPTX. Register as `ops` of group `export`.

### Phase 3 — Finish the renderers the PRD names (3–4 weeks)
15. **Presenter mode** for `PresentationRenderer` (fullscreen, timer, next-slide preview, speaker notes pane).
16. **Spreadsheet**: sort/filter/group + a minimal formula engine (`hyperformula`) + XLSX import/export.
17. **Website**: multi-file model + a `deploy` op (Vercel MCP is available in this very environment) + true hot reload.
18. **Document**: focus mode, outline panel, **backlinks** in the context panel (`getLinks(noteId)` already exists in the seam), template picker.

### Phase 4 — Native desktop affordances (1–2 weeks)
19. Global hotkey (`tauri-plugin-global-shortcut`) → summon command bar.
20. Native notifications for sync/inbox events (`tauri-plugin-notification`).
21. File watcher → react to external vault edits without poll.

### Phase 5 — Hardening & a11y pass (ongoing)
22. Focus traps + ARIA across modals and icon buttons; 44px touch targets.
23. Per-email magic-link throttle (S6).
24. Frontend test seed: Playwright smoke of the three core flows (open note → edit → autosave; ⌘K create; share link round-trip). Wire into CI.

---

## 7. Highest-leverage moves if you only do five things

1. **Sanitize HTML (S1) + enable Tauri CSP (S2).** This is the one genuine vulnerability and its only backstop.
2. **Error boundaries.** Cheapest possible jump in perceived polish/robustness.
3. **CI + ESLint.** You cannot keep ~36k LOC production-ready by hand; nothing currently guards regressions except a manual typecheck.
4. **The operation registry + single `inferKind` oracle.** The first-principles refactor that makes the agent real and stops note corruption — and makes export/deploy/sync cheap to add afterward.
5. **Export pipeline.** The most visible unmet PRD promise ("time-to-share < 5s") and the thing a user notices missing on day one.

Everything else is a leaf you can pick at incrementally. These five are the trunk.
