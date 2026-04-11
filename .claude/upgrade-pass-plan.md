# Prism Upgrade Pass Plan

**Date:** April 11, 2026 | **Status:** In Progress

## Workstreams

### WS1+5: First-Run Setup + Integration Verification
- Config persistence via `prism-config.json` (fallback: omniharmonic .env → defaults)
- Guided onboarding wizard: Parachute → Matrix → Google → Notion → Claude
- Test connection buttons with real-time status
- `Arc<RwLock<AppConfig>>` for runtime-mutable config

### WS2: Wikilink Resolution + Rendering  
- TipTap WikilinkExtension: `[[text]]` renders as clickable inline links
- Preview mode before committing link creation
- Batch resolution with progress tracking
- WikilinkManager panel

### WS3: Tag-Based Navigation
- Interactive tag chips in MetadataPanel (click to see all notes with tag)
- Tag schema field display (status, priority, due as form controls)
- TagView page showing all notes with a tag
- Tags section in sidebar

### WS4: Dashboard Renderer
- New "dashboard" content type with configurable widget grid
- Widget types: task-list, note-list, stat-card, calendar-events, message-summary
- DashboardEditor for adding/configuring widgets
- Saves layout config as note metadata

## Execution Order
1. WS1+5 (foundation — all other work assumes configurable integrations)
2. WS2, WS3, WS4 in parallel (independent workstreams)

## Merge Order for lib.rs
1. WS1+5 commands
2. WS2 commands (wikilinks already registered)
3. WS3 commands (vault_get_tag_schema, vault_list_notes_by_tag)
4. WS4 (no new Rust commands — dashboard is frontend-only)
