// Global design system — importing `@prism/core` wires up tokens, glass, and
// typography for whichever host shell mounts the UI.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";

// App shell
export { default as App } from "./App";

// Collaborative editor (CRDT) — host shells supply the Yjs doc + provider.
export { CollabEditor } from "./components/renderers/CollabEditor";
export type { CollabUser, AwarenessProvider } from "./components/renderers/CollabEditor";

// Data-source seam — the boundary every host shell implements.
export { VaultClientProvider, useVaultClient } from "./data/VaultClientContext";
export type { VaultClient, VaultLink, VaultGraph } from "./data/VaultClient";

// Collab sharing seam — host shells inject how share links are minted.
export { CollabSharingProvider, useCollabSharing } from "./data/CollabSharing";
export type {
  CollabSharing,
  ShareLevel,
  ShareLink,
  SharePerson,
  TagAccess,
  NoteAccess,
} from "./data/CollabSharing";
export { ShareDialog } from "./components/layout/ShareDialog";
export { CommentsSidebar } from "./components/renderers/CommentsSidebar";

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
