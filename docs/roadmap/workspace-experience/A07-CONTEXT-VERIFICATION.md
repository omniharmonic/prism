# A07 contextual panels

2026-10-02. Links source `10f7e7c`. Links checkpoint against FRONTEND-ACCEPTANCE A07 / R03.1 / R09.5 and board12 (`12-properties-related-context.png`). History audit references board13 (`13-document-history.png`). This does not claim unified human/agent/comment activity.

## Links implemented

`LinksPanel` now uses the injected VaultClient instead of direct Tauri calls. The actual `getNote(id, { fresh: true })` contract is used to check source access, resolve linked notes and authorize opening. Source and target IDs must match exactly; unrelated edges from a broader host are filtered out.

The panel separates incoming and outgoing relationships with note titles, paths and the real relationship label. Only loaded rows render. Up to20 target notes resolve in parallel per explicit page, with deduplication within that page. Load more exposes the remaining edges without rendering raw IDs as fallback titles. Failed, unavailable, empty and unsupported states are distinct; failures never masquerade as an empty vault.

State and queries are bound to audience and source note. Cached rows are hidden during source/target revalidation. Changing workspace or document discards a delayed open result. Clicking a row performs a fresh read and uses the returned title/type; a failed open hides that row's old title and offers recovery. There is no note body write or optimistic navigation based on an old cached note.

Styling is confined to `context-panels.css` under `.prism-context-links` and descendants. It follows the board's restrained linked-note rows while reporting only explicit vault relationships. No semantic recommendation or agent activity is fabricated. Existing graph navigation remains in the companion's Graph tab.

## Verification

- 18/18 Chromium/WebKit cases passed:20 concurrent target requests, explicit second page, incoming/outgoing groups, fresh open, renamed target, failure recovery, denied target/source, missing capability, empty result, delayed workspace/document switch, and hidden cached titles during revalidation.
- No source mutations occurred in fixtures; all note reads used `fresh:true`. Private error strings and raw unresolved target IDs stayed out of the DOM.
- Core typecheck, aggregate web fixture typecheck and whitespace checks passed.
- Desktop,390px and dark screenshots were inspected. Tests write only to `testInfo.outputPath`; selected fictional captures are explicitly copied to [evidence/a07-context](evidence/a07-context).

The fixture renders the actual LinksPanel with an injected web client. It does not prove integrated companion scroll/session preservation or production access behavior. Root owns the full shell and release checks. No backend, transport contract or ContextPanel rewrite is included.

## Properties implemented — source `a99c4ff`

`ContextPanel` supplies the selected note, with no separate read-only prop. MetadataPanel now uses the existing `reviewMode(note)` seam: annotated read-only/propose actors see properties, tags, timestamps and configured sync destinations without mutation controls. Owners/legacy notes without `_caps`, and actors with `edit`, keep editing. The existing web sync owner gate remains intact; the earlier audit incorrectly implied SyncSection had no independent owner gate.

Tags use the injected client, scoped suggestions and recoverable pending/error states. Text properties commit on blur/Enter rather than every keystroke. Failed text and array input stays visible; Retry repeats the attempted value. Controls have accessible names, the boolean switch exposes its checked state, and primary phone controls have44px targets. Panel state resets for note/audience changes; sibling-tag field discovery is scoped and hides cached values during revalidation. Note type, tag schemas, arrays, advanced JSON and sync workflows remain available.

18/18 Chromium/WebKit tests passed through the **actual ContextPanel host**, covering read-only/propose visibility, owner/explicit-edit compatibility, deferred text saves, failed retry, injected tag add/remove, duplicate-submit prevention, array failure recovery and scope reset. Scoped mutation assertions show metadata-only updates; no note body is submitted. Core and aggregate fixture typechecks passed. Desktop,390px WebKit and dark screenshots were inspected and copied explicitly to the evidence directory. Fixtures have no HostServices owner connection and therefore correctly display the existing unavailable-sync notice; they do not claim a production sync test.

## History implemented — source `779b7a3`

The actual companion host's Activity tab now identifies this surface as **Version history**, with saved dates and the real vault `actor`/`via` fields only when supplied. Current-note timestamps, empty history and unsupported legacy history remain distinct. Retention copy defers to the vault configuration. This does not claim a unified stream of agent actions, comments or accepted suggestions.

List, version-body and current-comparison queries are audience-scoped. They fresh-read the exact source note before accessing history; bodies and list rows are hidden while revalidating or after failure. List pagination remains 50 versions per request. A currently open viewer retains its identity through a save-triggered list refresh, while its own source/body queries revalidate independently. Changing audience/note resets the viewer.

VersionViewer uses a native modal dialog, explicit keyboard cycling and launcher focus restoration. The Chromium browser chrome boundary and Safari's implicit-button Tab behavior required explicit handling. Escape closes, arrow shortcuts step between versions, current/previous comparison and full text remain available. Scoped light/dark/phone styling wraps attribution, keeps controls reachable and avoids horizontal dialog overflow. Error messages are safe and actionable with retries.

Restore preserves the existing sequence: flush pending editor saves, fresh-read the note, check the existing `reviewMode` edit capability, use the **post-flush updatedAt** for optimistic concurrency, then discard stale pending state and remount the editor on success. Missing `_caps` continues to allow owner/legacy behavior. Audience checks run before/after awaited steps. If the audience changes after a restore request has already reached the server, the frontend cannot cancel that server operation, but it does not apply the late result to the new audience's caches, drafts or editor revision. Conflict errors remain visible and ask the user to review the latest state.

28/28 Chromium/WebKit cases passed through actual ContextPanel with an injected fictional client. The real `useAutoSave` hook proves flush → fresh timestamp → restore, with one revision bump on success. Coverage also includes 50+2 pagination, supplied attribution, absent attribution for readers, focus cycling and return, read-only/propose browsing, owner/edit restore, denied edit access before the write, conflict recovery, list/body retry, empty/unsupported states, audience changes both before and after request dispatch, and hiding a cached body before a revoked source response. Core and aggregate fixture typechecks passed. Desktop,390px WebKit and dark history/viewer screenshots were inspected and copied explicitly; tests themselves write only test artifacts.

## Boundaries and integration

These checkpoints change frontend presentation and existing client method use only. No server, transport contract, CollabDoc or ContextPanel source changes are included. Existing sync, full-shell scrolling and production role enforcement still need the root agent's integrated release checks. ReviewMode UI gating supplements server authorization; it does not replace it. The fixtures exercise the actual companion mounts without owner credentials or live data.
