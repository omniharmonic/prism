# Prism ↔ Parachute Vault Alignment Plan

**Version:** 1.0 | **Date:** April 10, 2026 | **Status:** Draft — Awaiting Design Decisions

---

## Problem Statement

Prism's renderer system is driven by `metadata.type` on each Parachute note, but the existing vault (1,116 notes, 591 tags, 24 tag schemas) uses **tags** as the primary type system with structured metadata in **tag schema fields**. These two systems overlap but don't align 1:1. This plan bridges them without breaking the existing vault workflow.

---

## Gap Analysis

| What Prism Expects | What Parachute Has Today |
|---|---|
| `metadata.type` field on every note (e.g. `"document"`, `"task"`, `"presentation"`) | No `metadata.type` field. Type expressed via **tags** (`task`, `meeting`, `writing`, `slides`, `concept`) |
| `metadata.project` field for project association | Project association via tags (`opencivics`, project-specific tags) and path structure (`vault/projects/<name>/`) |
| `metadata.status`, `metadata.priority`, etc. as flat metadata fields | Status/priority stored in **tag schema fields** (e.g. the `task` tag schema has `status`, `priority`, `due`) |
| Notes organized by `path` like `Projects/SquadSwarm/prd` | Notes organized by filesystem paths like `vault/projects/bioregional-coordination/` |
| `SyncConfig[]` in metadata for external sync destinations | No sync metadata (not yet needed) |
| 15 distinct `ContentType` values | 24 tag schemas, many of which map to `"document"` in Prism's world |
| `metadata.schema_version` for migration | No schema versioning |

---

## Phase 1: Define the Tag-to-ContentType Mapping

**Status:** ⬜ Needs design decision

Create a definitive mapping from existing Parachute tags to Prism's `ContentType` enum.

### Proposed Mapping

| Parachute Tag | → Prism ContentType | Rationale |
|---|---|---|
| `task` | `"task"` | Direct match |
| `meeting` | `"document"` | Meeting notes render as rich docs |
| `transcript` | `"document"` | Transcripts are read-only docs |
| `concept` | `"document"` | Knowledge articles |
| `writing` | `"document"` | Essays, articles |
| `research` | `"document"` | Research docs |
| `proposal` | `"document"` | Proposals |
| `briefing` | `"briefing"` | Direct match |
| `slides` | `"presentation"` | Direct match |
| `script` | `"document"` | Scripts for talks |
| `spec` | `"document"` | Technical specs |
| `dashboard` | `"project"` | Aggregation view |
| `person` | `"document"` | Contact cards (read-only doc) |
| `organization` | `"document"` | Org profiles |
| `project` (tag) | `"project"` | Project dashboard |
| `decision-record` | `"document"` | Decision docs |
| `grant-application` | `"document"` | Grant proposals |
| `project-update` | `"document"` | Status updates |
| `project-page` | `"website"` | If it has a URL, possibly a site |
| `page` | `"document"` | Generic pages |
| (no matching tag) | `"document"` | Default fallback |

### Open Question

Should `person` and `organization` notes get their own lightweight renderer (a contact card view), or is the DocumentRenderer sufficient? This is a UX trade-off worth deciding early.

---

## Phase 2: Implement `inferContentType` Using Tags

**Status:** ⬜ Blocked on Phase 1

The technical architecture (Section 6.2) already specifies an `inferContentType` function. Extend it to use Parachute tags as the primary inference source, since most of the 1,116 existing notes won't have `metadata.type`.

### Priority Order

```
1. Explicit metadata.type (if set) — always wins
2. Tag-based inference — check tags against the Phase 1 mapping table
3. Path-based inference — check note.path patterns
4. Content-based inference — look at the markdown itself
5. Default to "document"
```

This means the frontend can work with the vault **as-is** without migrating any notes.

### Implementation Location

`src/lib/types.ts` — the `inferContentType` function (~30 lines)

---

## Phase 3: Map Tag Schema Fields to PrismMetadata

**Status:** ⬜ Blocked on Phase 1

Prism expects flat metadata fields (`status`, `priority`, `deadline`). Parachute stores these inside tag schemas. A normalization layer is needed.

### Example: Task Tag Schema → PrismMetadata

```
Parachute tag schema "task":
  status: "todo" | "in-progress" | "blocked" | "done" | "cancelled"
  priority: "critical" | "high" | "medium" | "low"
  due: date
  project: text

→ Normalize to PrismMetadata:
  type: "task"
  status: (same values)
  priority: (same values)
  deadline: due       ← field rename
  project: project
```

### Design Decision: Where Does Normalization Happen?

- **Option A (recommended):** In the Rust `commands/vault.rs` — the backend reads raw Parachute notes and enriches them with derived `PrismMetadata` before returning to the frontend. The frontend never sees raw tag schema data. Aligns with architecture principle: "frontend decides nothing about data."
- **Option B:** In the frontend `lib/parachute.ts` — simpler but less principled.

### Important: Pass Through Unknown Fields

The vault's tag schemas are richer than PrismMetadata currently defines. For example, `meeting` has `source`, `recording_id`, `fathom_url`. The normalization layer should pass through unknown fields rather than dropping them — these could power future renderers.

---

## Phase 4: Align Path Conventions

**Status:** ⬜ Independent

The vault uses paths like `vault/projects/bioregional-coordination/`. Prism expects `Projects/SquadSwarm/prd`. The path-to-project parser needs to handle actual vault structure.

### Path Mapping

```
Current vault paths:              Prism's expected pattern:
vault/projects/<name>/            Projects/<Name>/
vault/people/                     People/
vault/_staging/new/               (filter out — not user content)
vault/_inbox/transcripts/         Communications/Inbox/
vault/_templates/                 (filter out — templates, not content)
```

### Proposed Approach

Add a path normalization step in the Rust backend that strips the `vault/` prefix and maps conventions. Alternatively, update `buildProjectTree` in the frontend to understand both path patterns.

### Navigation Sidebar Considerations

- `_staging/new/` and `_inbox/transcripts/` represent an ingestion pipeline (voice memos → transcription → cleanup → filing). Show these as a separate "Processing" section rather than mixing into Projects.
- `_templates/` should be hidden from the tree but accessible via the "New content" flow.

---

## Phase 5: Decide on Metadata Write-Back Strategy

**Status:** ⬜ Needs design decision

When a user changes a task's status in Prism (e.g. dragging a kanban card), where does that write go?

- **Option A (recommended):** Write to **both** the Parachute tag schema field AND a `metadata.type` field. Prism gradually enriches notes with explicit `metadata.type` as users interact with them, while keeping tag schema fields in sync for Parachute's own tools (MCP, other clients).
- **Option B:** Only write to tag schema fields, and always infer type from tags. Simpler, but means Prism never has a "clean" metadata.type to read.

---

## Phase 6: Handle Existing Notes vs. New Notes

**Status:** ⬜ Blocked on Phases 1, 5

### Strategy

1. **Don't bulk-migrate existing notes** — `inferContentType` handles them via tags
2. **New notes get explicit metadata.type** — set on creation using `CONTENT_DEFAULTS`
3. **Edited notes get metadata.type backfilled** — when a user opens and saves an existing note, the backend adds `metadata.type` if missing
4. **Optional:** A one-time enrichment script that batch-adds `metadata.type` to all existing notes based on the tag mapping. Could run as a Tauri command or standalone script.

---

## Execution Order

| Step | Phase | Effort | Dependencies |
|------|-------|--------|-------------|
| 1 | Tag-to-ContentType mapping | Design decision | None — needs your input |
| 2 | `inferContentType` with tag awareness | ~30 lines, frontend | Phase 1 |
| 3 | Path normalization | ~20 lines, backend or frontend | None |
| 4 | Tag schema → PrismMetadata normalization | ~50 lines, Rust backend | Phase 1 |
| 5 | Write-back strategy on save | ~15 lines | Phase 1, 5 decision |
| 6 | Optional batch enrichment | Standalone script | Phases 1-5 |

---

## Key Observations

- With 591 unique tags and only 15 ContentTypes, most tags are **semantic/topical** (like `governance`, `bioregional`, `philosophy`) rather than structural. These should flow through to the Context Panel as filterable tags, not influence renderer selection.
- The vault's tag schemas are actually *richer* than PrismMetadata — fields like `fathom_url`, `recording_id`, `confidence` could power specialized UX later.
- The existing vault directory structure (`_staging`, `_inbox`, `_templates`) represents an ingestion pipeline that Prism should surface as a workflow, not just a file tree.
