// Global design system — importing `@prism/core` wires up tokens, glass, and
// typography for whichever host shell mounts the UI.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";
import "./styles/collab.css";
import "./styles/workspace.css";

export { PrismMark, PrismAppIcon } from "./components/brand/PrismMark";

// App shell
export { default as App, type InitialTab } from "./App";
export { GovernancePanel } from "./components/renderers/network/governance/GovernancePanel";
export { CommonsMap } from "./components/map/CommonsMap";
export type { MapFeature, CommonsMapProps } from "./components/map/CommonsMap";
export { BASEMAPS, DEFAULT_BASEMAP, resolveBasemap, kindColor } from "./components/map/basemaps";
export { setMapProxyFetch, mapProxyActive, proxiedStyle, protocolUrlToPath, localizeStyle, createMapProtocolHandler, MAP_PROTOCOL } from "./components/map/mapProxy";

// Collaborative editor (CRDT) — host shells supply the Yjs doc + provider.
export { CollabEditor } from "./components/renderers/CollabEditor";
export { COLLAB_SCHEMA_VERSION } from "./editor/collabSchema";
export type { CollabUser, AwarenessProvider } from "./components/renderers/CollabEditor";
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
export { CommentsSidebar } from "./components/renderers/CommentsSidebar";
export { collabAffordances, type CollabAffordances } from "./lib/collab/access";
export { PageHeader, PageProperties, FontSwitch, renamePath } from "./components/renderers/DocumentChrome";
export type { ContentFont } from "./components/renderers/DocumentChrome";
export { useUpdateNote, useNotes } from "./app/hooks/useParachute";
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
export { PagesRequestError, TRASH_TAG, sanitizePreferences, type MoveRequest, type MoveResult, type TrashItem, type TrashListing, type PreferencesSnapshot, type PagePreferences } from "./lib/pages/model";
