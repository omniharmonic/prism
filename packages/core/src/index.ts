// Global design system — importing `@prism/core` wires up tokens, glass, and
// typography for whichever host shell mounts the UI.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";
import "./styles/collab.css";

// App shell
export { default as App, type InitialTab } from "./App";
export { GovernancePanel } from "./components/renderers/network/governance/GovernancePanel";
export { CommonsMap } from "./components/map/CommonsMap";
export type { MapFeature, CommonsMapProps } from "./components/map/CommonsMap";
export { BASEMAPS, DEFAULT_BASEMAP, resolveBasemap, kindColor } from "./components/map/basemaps";

// Collaborative editor (CRDT) — host shells supply the Yjs doc + provider.
export { CollabEditor } from "./components/renderers/CollabEditor";
export type { CollabUser, AwarenessProvider } from "./components/renderers/CollabEditor";
export type { Editor } from "@tiptap/react";
export { CollabCodeEditor, detectCodeLanguage } from "./components/renderers/CollabCodeEditor";
export { CollabSpreadsheet } from "./components/renderers/CollabSpreadsheet";
export { CollabCanvas } from "./components/renderers/CollabCanvas";

// Content-type detection — shared so every shell + the collab layer agree.
export { inferContentType, looksLikeExcalidrawScene } from "./lib/schemas/content-types";
export { sanitizeHtml } from "./lib/html/sanitize";

// Data-source seam — the boundary every host shell implements.
export { VaultClientProvider, useVaultClient } from "./data/VaultClientContext";
export type {
  VaultClient,
  VaultLink,
  VaultGraph,
  SemanticHit,
  NoteVersion,
  NoteVersionSummary,
  NoteVersionPage,
} from "./data/VaultClient";
export { HistoryUnavailableError, HistoryConflictError, toNoteVersion } from "./data/VaultClient";
export { GraphCanvas } from "./components/layout/GraphPanel";
export type { GraphNode, GraphLink, GraphData } from "./components/layout/GraphPanel";

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
  IntegrationStatus,
} from "./data/CollabSharing";
export { ShareDialog } from "./components/layout/ShareDialog";
export { CommentsSidebar } from "./components/renderers/CommentsSidebar";
export { collabAffordances, type CollabAffordances } from "./lib/collab/access";
export { PageHeader, FontSwitch, renamePath } from "./components/renderers/DocumentChrome";
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
export { AgentClientProvider, useAgentClient, useAgentAvailable, useAgentAvailability, agentKeys, type AgentAvailability } from "./data/AgentClientContext";
export { createHttpAgentClient, type HttpAgentClientOptions, type AgentFetch } from "./lib/agent/httpAgentClient";
export { AgentApiError, isTerminalTurn } from "./lib/agent/sessions";
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
  AgentTurnStatus,
  CreateSessionParams,
} from "./lib/agent/sessions";
export { openAgentChat, useAgentChatStore, AGENT_CHAT_TAB } from "./lib/agent/chatStore";
