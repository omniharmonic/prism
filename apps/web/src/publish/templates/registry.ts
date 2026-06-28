import { lazy } from "react";
import type { PublicationTemplate } from "./types";

/**
 * Publication template registry. Maps a manifest `template` name → a lazy React
 * component implementing {@link PublicationTemplate}. New templates (e.g. a
 * landing page, a docs theme) register here without touching PublicationView.
 *
 * Mirrors `packages/core/.../renderers/Registry.ts`: lazy + keyed, with a
 * single fallback ("wiki") so an unknown template still renders something sane.
 */

const WikiTemplate = lazy(() => import("./WikiTemplate"));

const TEMPLATE_MAP: Record<string, React.LazyExoticComponent<PublicationTemplate>> = {
  wiki: WikiTemplate,
};

export const DEFAULT_TEMPLATE = "wiki";

/** Resolve a template name to its component, falling back to the wiki template. */
export function getTemplate(name?: string | null): React.LazyExoticComponent<PublicationTemplate> {
  return (name && TEMPLATE_MAP[name]) || TEMPLATE_MAP[DEFAULT_TEMPLATE];
}
