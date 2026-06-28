import type { ComponentType } from "react";

/**
 * Shared contract between PublicationView (the data shell) and the publication
 * templates (the presentation). A template gets the fully-fetched manifest, the
 * active note, the publication-scoped graph, and a navigate callback; it owns
 * all chrome and layout. Mirrors the spirit of the core renderer Registry: a
 * small keyed, lazy map from a name → component implementing one interface.
 */

export interface NavNote {
  id: string;
  title: string;
  path: string | null;
  tags: string[];
}

export interface PublicationManifest {
  slug: string;
  title: string;
  template: string;
  theme: unknown | null;
  homeNoteId: string | null;
  passwordRequired: boolean;
  notes: NavNote[];
}

export interface PubNote {
  id: string;
  content: string;
  path: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  title: string;
}

export interface PubGraph {
  nodes: { id: string; title: string }[];
  edges: { source: string; target: string }[];
}

export interface PublicationTemplateProps {
  manifest: PublicationManifest;
  slug: string;
  /** The note currently being viewed (null until loaded / when none selected). */
  activeId: string | null;
  /** Loaded body for `activeId` (null while loading or unavailable). */
  note: PubNote | null;
  noteLoading: boolean;
  /** In-publication navigation: updates the URL + active note without a reload. */
  onNavigate: (id: string) => void;
  /** Publication-scoped graph (null until loaded / on error). Drives backlinks. */
  graph: PubGraph | null;
}

export type PublicationTemplate = ComponentType<PublicationTemplateProps>;
