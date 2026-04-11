# Prism Gap Closure Plan — Post-Audit

**Date:** April 11, 2026 | Based on comprehensive PRD audit

---

## Priority 1: Critical Functional Gaps (Broken/Missing Core UX)

### P1.1 — Wire ⌘J inline prompt
- `InlinePrompt.tsx` is built but never rendered or triggered
- Add ⌘J to keyboard shortcuts, capture text selection from TipTap, render InlinePrompt

### P1.2 — Fix sync_trigger dispatch (make sync actually work)
- `sync_cmds.rs` returns stub errors for ALL adapters
- Wire the Google Docs adapter (use `gog` token bridge) and Notion adapter (use .env API key)
- Test with a sandbox document

### P1.3 — Fix Google Docs adapter auth
- Currently uses a dead `get_token()` that always fails
- Bridge to `gog` CLI token system (same as Gmail client)

### P1.4 — Wire Notion API key
- Key is loaded from .env into `AppConfig` but never passed to `NotionAdapter`
- Create the adapter with the config key in `sync_trigger`

### P1.5 — Build SpreadsheetRenderer
- Completely missing — PRD §3.8 specifies TanStack Table
- Package is already installed (`@tanstack/react-table`)

### P1.6 — Build WebsiteRenderer
- Completely missing — PRD §3.9 specifies split code + live preview
- Use iframe for preview, Monaco for code

### P1.7 — Wikilink → Parachute link resolution
- Imported Obsidian vault has `[[wikilinks]]` in content
- Need a processor to find wikilinks, resolve to note IDs, and create Parachute links

---

## Priority 2: Incomplete Features (Partial implementations)

### P2.1 — Command bar: add Transform, Sync, Navigate commands
- Currently only has Create + Search
- Add: "Sync to Google Docs", "Sync to Notion", "Turn into presentation", "Open settings"
- Wire "Ask Claude" fallthrough to actually open agent panel

### P2.2 — PresentationRenderer: use TipTap per slide
- Currently uses raw textarea for editing
- Use the same TipTap instance as DocumentRenderer

### P2.3 — TaskBoardRenderer: add Inbox column + filters
- PRD specifies 5 columns; we have 4
- Add project/priority filter dropdowns

### P2.4 — Email: wire Reply button + inbox list view
- Reply button has a TODO comment
- Need an inbox mode that lists threads

### P2.5 — Calendar: add event creation UI + month view
- API exists but no "New Event" button or form

### P2.6 — Navigation: add "Recent" section
- Track recently opened tabs, show in sidebar

### P2.7 — Unread counts: wire Matrix poller service
- `matrix_poller.rs` is stubbed in services/mod.rs
- Need background Tokio task that long-polls /sync

---

## Priority 3: Polish & Extended Features

### P3.1 — Inbox: merge Gmail unread into unified inbox
### P3.2 — Project renderer: wire threads + events sections
### P3.3 — Document: focus mode, outline panel, slash commands
### P3.4 — Cross-type transformation UI in command bar
### P3.5 — Background service infrastructure (pollers, schedulers)

---

## Execution Order

Start with P1 (critical gaps), then P2, then P3.
P1.1-P1.4 can be done in parallel.
P1.5-P1.6 are independent renderer builds.
P1.7 is a data migration task.
