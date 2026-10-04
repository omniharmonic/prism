/**
 * `@prism/core/shell` — everything a host needs to START the app, and nothing that loads
 * the block editor (NP-PF-08: TipTap, ProseMirror, Yjs and highlight.js stay out of the
 * app's initial JavaScript). `@prism/core` (index.ts) re-exports this module and adds the
 * editor components. A module that is part of the web app's boot path imports from HERE;
 * a module that is itself loaded lazily (a live document, a fixture) may use `@prism/core`.
 * Guard: `npm run check:initial -w @prism/web`.
 */
// Global design system — importing `@prism/core` wires up tokens, glass, and
// typography for whichever host shell mounts the UI.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";
import "./styles/collab.css";
import "./styles/workspace.css";
import "./styles/shell.css";
import "./styles/touch.css";
import "./styles/print.css";
import { installImeKeyGuard } from "./lib/ime/keyGuard";

// NP-AX-08: keys that belong to an IME composition never reach app handlers (see keyGuard.ts).
installImeKeyGuard();
export { installImeKeyGuard, isImeKey } from "./lib/ime/keyGuard";

export { PrismMark, PrismAppIcon } from "./components/brand/PrismMark";

// App shell
export { default as App, type InitialTab } from "./App";
export { GovernancePanel } from "./components/renderers/network/governance/GovernancePanel";
// CommonsMap is NOT re-exported here: a static export pulls maplibre-gl (~780 KB) into the
// app's initial JavaScript (NP-PF-08). Load it lazily: `import("@prism/core/map")`.
export type { MapFeature, CommonsMapProps } from "./components/map/CommonsMap";
export { BASEMAPS, DEFAULT_BASEMAP, resolveBasemap, kindColor } from "./components/map/basemaps";
export { setMapProxyFetch, mapProxyActive, proxiedStyle, protocolUrlToPath, localizeStyle, createMapProtocolHandler, MAP_PROTOCOL } from "./components/map/mapProxy";

// Collaborative editor (CRDT) — host shells supply the Yjs doc + provider. Only TYPES and
// the lazy editors here: the editor itself (TipTap, ProseMirror, Yjs, highlight.js) is
// exported by `@prism/core` (index.ts), never by this module — see the header.
export { COLLAB_SCHEMA_VERSION } from "./editor/schemaVersion";
export type { CollabUser, AwarenessProvider } from "./components/renderers/CollabEditor";
export type { CommentCommandActions } from "./components/renderers/CommentsSidebar";
export type { HumanCommandChannel } from "./components/renderers/HumanSuggestionComposer";
export type { PresentPerson, PresenceAwareness } from "./components/sharing/PresenceAvatars";
export type { MentionKind, MentionAttrs } from "./lib/tiptap/MentionNode";
export type { Editor } from "@tiptap/react";
export { CollabCodeEditor, CollabSpreadsheet, CollabCanvas } from "./components/renderers/LazyCollabEditors";
export { detectCodeLanguage } from "./lib/code-language";

// Content-type detection — shared so every shell + the collab layer agree.
export { inferContentType, looksLikeExcalidrawScene } from "./lib/schemas/content-types";
export { sanitizeHtml } from "./lib/html/sanitize";

// Data-source seam — the boundary every host shell implements.
export { VaultClientProvider, useVaultClient } from "./data/VaultClientContext";
export type {
  VaultClient,
  PersonSummary,
  PeoplePage,
  PersonPage,
  VaultLink,
  VaultGraph,
  VaultNeighborhood,
  SemanticHit,
  NoteVersion,
  NoteVersionSummary,
  NoteVersionPage,
  UploadedAttachment,
} from "./data/VaultClient";
export { VaultRequestError, isAccessUnavailable, HistoryUnavailableError, HistoryConflictError, toNoteVersion } from "./data/VaultClient";
// Typed properties + database views (seam types, conflict error, pure engine).
export { PropertyConflictError, type PropertyWriteResult } from "./data/VaultClient";
export type { QuerySpec, QueryPage, QueryRow, SchemaMap, SchemaPatch, TagSchema, SchemaField, PropertyDef, PropertyKind } from "./lib/database";
export { PropertyBar } from "./components/database/PropertyBar";
export { NotePropertyBar } from "./components/database/NotePropertyBar";
export { createDatabaseNote } from "./components/database/createDatabase";
// CSV → a NEW database (NP-DB-25): the dialog and its pure/imperative parts, for any import entry point.
export { CsvNewDatabaseDialog, importCsvAsNewDatabase, planNewDatabase, NewDatabaseError } from "./components/database/Csv";
// Inline + linked database blocks (the editor's `databaseView` atom renders these).
export { DatabaseBlock, renderDatabaseBlock, databaseBlockHtml, parseDatabaseBlock, createInlineDatabase, addLinkedView } from "./components/database/DatabaseBlock";
export type { PropertyBatchItem, PropertyBatchResult, CsvImportRequest, CsvImportResponse } from "./lib/database";
export { GraphCanvas } from "./components/layout/GraphCanvasLazy";
export type { GraphNode, GraphLink, GraphData } from "./components/layout/GraphCanvas3D";

// Collab sharing seam — host shells inject how share links are minted.
export { CollabSharingProvider, useCollabSharing, useVaultChangeSignal } from "./data/CollabSharing";
export { AccountProvider, useAccount } from "./data/Account";
export { PushProvider, usePush } from "./data/PushNotifications";
export type { PushClient, PushState } from "./data/PushNotifications";
export type { AccountClient, AccountProfile, SignedInDevice, AgentToken, AgentTokenList, CreatedAgentToken } from "./data/Account";
export { PlatformProvider, usePlatform, useIsWeb, type Platform } from "./data/Platform";
export { DesktopOnlyNotice } from "./components/ui/DesktopOnlyNotice";
export type {
  CollabSharing,
  ShareLevel,
  ShareLink,
  SharePerson,
  TagAccess,
  NoteAccess,
  SetPersonResult,
  PublicationInfo,
  PublicationPreview,
  PublicationPresentation,
  PublicationPresentationState,
  PublicationTheme,
  NodeIdentity,
  PeerInfo,
  PeerEditInfo,
  SpaceInfo,
  SpacePeerGrant,
  PairingCode,
  MirrorRequestInfo,
  VaultSummary,
  WorkspaceGrant,
  WorkspaceMember,
  WorkspaceRole,
  ViewerIdentity,
  WorkspaceVaultRef,
  WorkspacePerson,
  WorkspaceOverview,
  WorkspaceEntity,
  TunnelStatus,
  TunnelIngress,
  ServerInfo,
  WorkerSourceHealth,
  LegacyMcpToken,
  LegacyRevokeResult,
  IntegrationStatus,
} from "./data/CollabSharing";
export { ShareDialog } from "./components/layout/ShareDialog";
export { collabAffordances, type CollabAffordances, type CollabSocketScope } from "./lib/collab/access";
export { HumanCommandFailure, HUMAN_COMMAND_COPY } from "./lib/collab/human/failure";
export { PageHeader, PageProperties, FontSwitch, renamePath } from "./components/renderers/DocumentChrome";
export type { ContentFont } from "./components/renderers/DocumentChrome";
// Media, embeds, covers (wave 2B): page cover, attachment/cover helpers, embed allowlist.
export { PageCover, CoverPicker } from "./components/renderers/PageCover";
export { parseCover, coverPatch, coverForNote, gradientCss, COVER_GRADIENTS, safeMediaSrc, isOwnAttachment, attachmentKind, formatBytes, MAX_IMAGE_BYTES, MAX_FILE_BYTES } from "./lib/media/attachments";
export type { PageCover as PageCoverValue, AttachmentKind } from "./lib/media/attachments";
export { embedFor, isAllowedFrameSrc, safeWebUrl, EMBED_FRAME_ORIGINS, EMBED_FRAME_SOURCES, EMBED_SANDBOX } from "./lib/media/embeds";
export type { EmbedTarget, EmbedProvider } from "./lib/media/embeds";
export { useUpdateNote, useNotes, useVaultTree } from "./app/hooks/useParachute";
export { useUIStore } from "./app/stores/ui";
export { useWikilinkNavigate } from "./app/hooks/useWikilinkNavigate";
export { CollabDocumentProvider, useCollabDocumentSeam } from "./data/CollabDocumentContext";
export type { CollabDocumentSeam } from "./data/CollabDocumentContext";

// Shared data types host shells need to implement a VaultClient.
export type {
  Note,
  NoteFilters,
  NoteTreeEntry,
  CreateNoteParams,
  UpdateNoteParams,
  TagCount,
  VaultStats,
  VaultInfo,
  ContentType,
} from "./lib/types";

// The Tauri/desktop adapter delegates to this existing invoke-based client.
// (The web shell does NOT use this; it supplies its own fetch-based client.)
export { vaultApi } from "./lib/parachute/client";

// Settings bootstrap (theme/fonts) invoked by the host entry before render.
export { initializeSettings } from "./app/stores/settings";

// Transport seams (WP2.2): how shared UI reaches the Prism Server in any shell.
export { serverFetch, setServerFetch, type ServerFetch } from "./lib/transport/serverFetch";
// Import / export / print (wave 3A).
export { setTransferContextHeaders, transferApi, transferAvailable, TransferError } from "./lib/import-export/client";
export { useTransferUI, printCurrentPage } from "./lib/import-export/store";
// Recovered text (server owner): what a page held when a newer copy replaced unsaved typing.
export { RecoveredText, RecoverTextLink } from "./components/recovered/RecoveredText";
export { ImportExportHost, useCanManageTransfers } from "./components/import-export/ImportExportHost";
export { streamSSE, SSEParser, type SSEMessage, type StreamSSEOptions } from "./lib/transport/sse";

// Agent client seam (Arch v2 WP3.2): durable server-side agent sessions.
export { AgentClientProvider, useAgentClient, useAgentAvailable, useAgentAvailability, useAgentLimits, agentKeys, type AgentAvailability } from "./data/AgentClientContext";
export { InvalidationSourceProvider, InvalidationSubscriber } from "./data/InvalidationContext";
export { createInvalidator, parseInvalidationEvent, EXTRA_LIVE_KEYS, type InvalidationEvent, type InvalidationSource, type InvalidationHandlers } from "./lib/events/invalidation";
export { useLivePollMs, isEventChannelLive, LIVE_FALLBACK_MS } from "./lib/events/channelStatus";
export { createHttpAgentClient, type HttpAgentClientOptions, type AgentFetch } from "./lib/agent/httpAgentClient";
export { AgentApiError, isTerminalTurn } from "./lib/agent/sessions";
export { formatAgentCost, formatAgentBudget, fmtUsd, PROFILE_LABELS, SUBSCRIPTION_COST_TOOLTIP } from "./lib/agent/cost";
export type {
  AgentClient,
  AgentSession,
  AgentSessionSummary,
  AgentSessionDetail,
  AgentTurn,
  AgentEvent,
  AgentStreamMessage,
  AgentStreamHandlers,
  AgentProfile,
  AgentPermissionMode,
  AgentBilling,
  AgentLimits,
  AgentTurnStatus,
  CreateSessionParams,
} from "./lib/agent/sessions";
export { openAgentChat, useAgentChatStore, AGENT_CHAT_TAB } from "./lib/agent/chatStore";

// Host services seam (Arch v2 WP4.3): server-backed replacements for the legacy
// desktop's host commands (calendar range sync, note sync, Notion picker, inline agent).
export { HostServicesProvider, useHostServices } from "./data/HostServicesContext";
export {
  createHttpHostServices,
  HostServiceError,
  hostServiceErrorText,
  buildEditPrompt,
  buildTransformPrompt,
  cleanAgentText,
  type HostServices,
  type HostFetch,
  type HttpHostServicesOptions,
  type NoteSyncOutcome,
  type CalendarRangeResult,
  type NotionPageInfo,
  type AgentTextOptions,
  type GitHubSyncHost,
  type GitHubSyncInfo,
  type GitHubAuthStatus,
  type GitHubPushResult,
  type NotionDbSyncHost,
  type NotionDbSyncInfo,
  type NotionDbSyncRunResult,
  INTERACTIVE_SKILLS,
  type InteractiveSkill,
  type SkillRoute,
  type AgentRouting,
  type LocalModelInfo,
  type AgentModelsOverview,
  type RouteTestResult,
  type RunningSkill,
  type WikilinkJob,
  runWikilinkJobToEnd,
  wikilinkJobSummary,
} from "./lib/host/services";
export { useGitHubSyncApi, useNotionDbSyncApi } from "./lib/host/folderSync";
export {
  syncStatusFromNote,
  addSyncConfig,
  removeSyncConfig,
  extractWikilinks,
  matchWikilink,
  resolveWikilinks,
  queueSkillRun,
  updateSkillNote,
  validateSkillPatch,
  validateStructuredBlock,
  mergeSkillMetadata,
  type SkillPatch,
  SERVER_NOTE_SYNC_ADAPTERS,
  type VaultOpsClient,
  type NoteSyncConfig,
  type NoteSyncStatus,
  type WikilinkResolution,
} from "./lib/host/vaultOps";

// Live actions seam (Arch v2 WP1.5): email / calendar / Matrix actions via the server.
export { LiveActionsProvider, useLiveActionsClient, useLiveActionsStatus, useLiveActions } from "./data/LiveActionsContext";
export {
  createHttpLiveActionsClient,
  LiveActionError,
  liveActionErrorText,
  type LiveActionsClient,
  type LiveActionsStatus,
  type HttpLiveActionsOptions,
  type ActionsFetch,
  type EmailSendParams,
  type EmailReplyParams,
  type EmailTarget,
  type CalendarCreateParams,
  type RsvpResponse,
} from "./lib/actions/client";

export { useAgentDocumentSnapshot } from "./lib/agent/documentSnapshots";

export type { MatrixMessage, MessageBatch } from "./lib/matrix/types";

export { PublicationPreviewProvider, type PublicationPreviewProps } from "./data/PublicationPreviewContext";

export { TranscriptReviewClientProvider, useTranscriptReviewClient, type TranscriptReviewClient, type TranscriptReview, type TranscriptReviewItem, type TranscriptCandidate, type TranscriptDecision } from "./data/TranscriptReviewClientContext";

export { eligiblePublicationNavigation, parsePublicationNavigation, type PublicationNavigation } from "./lib/publishing/navigation";
// Pages: nested-page moves, Trash, synced preferences (lib/pages/model.ts).
export { renamePageFromTitle, TitleRenameRefused } from "./lib/pages/titleRename";
export { PagesRequestError, TRASH_TAG, sanitizePreferences, type MoveRequest, type MoveResult, type TrashItem, type TrashListing, type PreferencesSnapshot, type PagePreferences } from "./lib/pages/model";

// Sharing / review reads (wave 2D)
export type { SharedItem, SharedWithMeListing, IndexedThread, IndexedComment, WriterInfo, PageActivity, AccessPreview } from "./lib/sharing/types";
export type { InheritedPerson } from "./data/CollabSharing";
export { PersonAvatar, toneFor } from "./components/sharing/PersonAvatar";
export { SharedWithMe, useSharedWithMe, useViewerIsGuest } from "./components/sharing/SharedWithMe";
export { PageInfo, countText, plainText } from "./components/sharing/PageInfo";
export { PageUpdates, buildUpdates, type UpdateItem } from "./components/sharing/PageUpdates";
export { writerOf, writerTitle, writerName, lastEditedBy } from "./lib/history/attribution";
export { MoveAccessNotice, moveAccessSummary, useMoveAccessPreview } from "./components/sharing/MoveAccessNotice";
// Shell sync state + motion (wave 2E: NP-OF-01, NP-SB-15, NP-PG-06, NP-AX-06)
export { SyncStateBadge, OPEN_SAVED_CHANGES_EVENT } from "./components/layout/SyncStateBadge";
export { useSyncStore, useSyncStatus, deriveSyncStatus, markDirty, reportSaveFailure, reportSyncSource, reportPendingWrites, trackVaultWrites, NOT_SAVED_TO_PAGE, SAVING_TO_PAGE, unsavedExplanation, syncBadgeAction, type SyncStatus, type SyncKind } from "./lib/sync/syncState";
export { useReduceMotion, setReduceMotion, applyReduceMotion, prefersReducedMotion } from "./lib/motion";
export { setOfflineAvailability, useOfflineAvailability, type OfflineAvailability } from "./lib/offline/availability";
export { isVaultNoteId } from "./lib/noteIdentity";
export { BacklinksPill } from "./components/layout/BacklinksPill";
export { EmptyPageStarters } from "./components/renderers/EmptyPageStarters";
export { PageIcon, notePageIconChanged, pageIconWriteConfirmed, pageIconWriteFailed } from "./lib/pages/icons";
// Wave 2A: @-mentions, notifications inbox, reminders, access requests.
export { extractMentions, newMentions, extractCommentMentions, splitCommentMentions, commentMentionToken, type ParsedMention } from "./lib/tiptap/MentionParse";
export * from "./lib/notifications/client";
export * from "./lib/notifications/hooks";
export { openNotification, focusAnchor, anchorSelector, listenForInboxOpenRequests, setPendingNotification, ANCHOR_FLASH_CLASS } from "./lib/notifications/anchor";
export { InboxBadge, InboxNavButton, openInbox } from "./components/inbox/InboxNavButton";
export { RequestAccessButton } from "./components/inbox/RequestAccessButton";
