# Mobile sidebar investigation

The owner measured about three seconds to open the sidebar in iOS build 4, even after other surfaces became smooth.

## Reproduction and causes

The fictional workspace fixture now supports `?navigation&large-navigation`: 1,200 extra notes inside the active folder (1,206 rendered tree rows total). Profile with a 390×844 touch viewport and Chromium CPU throttled 4×. No production data is copied.

Before this change, opening mounted Navigation and its expanded ProjectTree each time. The active-folder reveal and row gesture setup added synchronous work. The original run recorded main-thread tasks of 2,896 ms on first opening and 3,969 ms on reopening. This was a stress reproduction, not a frame-rate measurement on the owner's phone.

Retaining the component alone was insufficient. ShellLayout also recreated the shortcuts provider's context on each visibility change, causing all row consumers to render again. A browser CPU trace additionally attributed substantial work to showModal; the timeline showed two style updates (~350 ms each) and layout across ~28,000 objects in the deliberately broad tree.

## Final change

- The shortcuts provider wraps ShellLayout, so opening a panel does not change its context.
- Mobile navigation warms during idle time and remains mounted inside its closed, inert native dialog. App's existing audience-keyed QueryClientProvider destroys it on account/vault changes.
- If first opening beats idle warm-up, the lightweight drawer animates before mounting the tree.
- `content-visibility: auto` on mobile tree rows lets the browser skip offscreen row contents while preserving native tree semantics, scrolling, keyboard focus, and accessibility. Unsupported browsers retain the lifecycle improvements.
- Page-row swipes and nested dialogs keep their own gestures; drawer dismissal uses other drawer space/header.

An experiment keeping the closed dialog laid out was discarded: normal native closed-dialog hiding performed better once offscreen row rendering was bounded. The final implementation does not override native closed-dialog display.

## Measurement

With a fixture server at port 5198, run `node apps/web/scripts/profile-mobile-sidebar.mjs`. `PRISM_PROFILE_ORIGIN` can select another local fixture origin.

`final.txt` records the final three trials: 153/118/120 ms to the first opening frame, 155/109/109 ms longest tasks, and 36/35/39 ms maximum subsequent frame gaps. Intermediate files document experiments, not acceptance thresholds. Device performance and very large first-time tree initialization still need physical acceptance; the improvement is not a promise of a specific iPhone frame rate.

Regression checks cover retained row identity/scroll/search, editor identity, hidden focus exclusion, cold opening, offscreen note activation, row gestures, and existing account/vault isolation.

## Build 6: prepare navigation during startup

Owner acceptance of build 5 found that the first few swipes and progressive tree appearance still felt unfinished. Idle mounting was only a best effort, and a closed native dialog did not retain its layout. Its cold path deliberately mounted the tree after the entrance animation; that behavior is now removed.

Mobile startup now mounts Navigation immediately and holds one workspace-opening screen until the tree, saved shortcuts, and workspace restoration have settled, followed by two animation frames for expansion and viewport layout. The closed drawer keeps its layout with `display: block`, `visibility: hidden`, `inert`, and explicit accessibility hiding. The tree and row instances remain alive between openings. Guests do not wait for a workspace tree they do not use. There is no artificial minimum loading duration. Slow/offline startup offers Retry and Continue after 12 seconds (or immediately on a tree error/paused request).

All tree data and expanded DOM are retained, but offscreen row painting remains browser-managed. An experiment forcing all 1,206 rows to render during every opening restored approximately one-second main-thread stalls under 4× CPU throttling, so that experiment was rejected. This change prioritizes complete first-use preparation, not a claim of faster warmed opening than build 5.

Tests cover startup with idle callbacks disabled, a held tree response, a stalled response escape, retained row/editor identity, scroll/search preservation, hidden focus exclusion, far-offscreen activation, gestures, and account/vault isolation. The profiling script now starts throttling before navigation and opens as soon as the startup boundary clears; it no longer grants an unmeasured 1.5-second idle warm-up. Physical first-swipe feel still needs owner acceptance.
