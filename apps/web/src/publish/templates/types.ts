import type { ComponentType } from "react";
import type { PublicationTheme } from "@prism/core";

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
  /** Owner-set presentation overrides (logo/colors/font); null/absent → default.
   *  Untrusted — every field is re-validated before it's applied to the page. */
  theme: PublicationTheme | null;
  homeNoteId: string | null;
  passwordRequired: boolean;
  notes: NavNote[];
  /** How many in-publication notes carry real geometry — drives whether the
   *  template offers a Map view (the feature payload itself is fetched lazily). */
  mapFeatureCount?: number;
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

/** One geospatial feature from the leak-proof /api/p/:slug/map endpoint —
 *  shaped to drop straight into core's CommonsMap `MapFeature`. */
export interface PubMapFeature {
  id: string;
  name: string;
  kind: string;
  sensing?: string;
  status?: string;
  geometry?: unknown | null;
  geo?: { lat: number; lon: number } | null;
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
  /** Publication-scoped map features (null until requested/loaded). Fetched
   *  LAZILY — call `onRequestMap` when the reader opens the map view; the shell
   *  loads /api/p/:slug/map once and re-renders with the features. */
  mapFeatures: PubMapFeature[] | null;
  onRequestMap: () => void;
}

export type PublicationTemplate = ComponentType<PublicationTemplateProps>;
