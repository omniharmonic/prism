// Global design system — importing `@prism/core` wires up tokens, glass, and
// typography for whichever host shell mounts the UI.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";
import "./styles/collab.css";

// App shell
export { default as App } from "./App";
export { GovernancePanel } from "./components/renderers/network/governance/GovernancePanel";

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
export type { VaultClient, VaultLink, VaultGraph, SemanticHit } from "./data/VaultClient";
export { GraphCanvas } from "./components/layout/GraphPanel";
export type { GraphNode, GraphLink, GraphData } from "./components/layout/GraphPanel";

// Collab sharing seam — host shells inject how share links are minted.
export { CollabSharingProvider, useCollabSharing, useVaultChangeSignal } from "./data/CollabSharing";
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
  SpaceInfo,
  SpacePeerGrant,
  PairingCode,
  MirrorRequestInfo,
  VaultSummary,
} from "./data/CollabSharing";
export { ShareDialog } from "./components/layout/ShareDialog";
export { CommentsSidebar } from "./components/renderers/CommentsSidebar";
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
