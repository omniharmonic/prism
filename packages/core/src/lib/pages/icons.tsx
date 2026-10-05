/**
 * Page icons outside the page itself (NP-PG-01): tabs, breadcrumbs, favorites,
 * recents. The icon comes from the sidebar tree (`metadata.icon`, already
 * permission-filtered), with a device-local override written the moment this
 * client changes an icon so every surface follows without waiting for a re-read.
 */
import { useContext, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useOptionalVaultClient } from "../../data/VaultClientContext";

import { usePageIconOverride } from "./iconStore";
import { PageIconView } from "./PageIconView";
export { PageIconView } from "./PageIconView";
export { parsePageIcon, pageIconAttachmentId, glyphIconValue, PAGE_ICON_NAMES, PAGE_ICON_COLORS, PAGE_ICON_COLOR_CSS } from "./iconValue";
export { pageIconOf, usePageIconOverride, notePageIconChanged, pageIconWriteConfirmed, pageIconWriteFailed } from "./iconStore";

function TreeIcon({ noteId, fallback }: { noteId: string; fallback: ReactNode }) {
  const { data: tree } = useVaultTree();
  return <PageIconView value={tree?.find((n) => n.id === noteId)?.metadata?.icon} noteId={noteId} fallback={fallback} />;
}

/**
 * The page's icon (emoji, its own uploaded image or a built-in glyph), else `fallback`.
 * Safe anywhere: without a query client or vault client (bare fixtures, static
 * previews) it renders the fallback.
 */
export function PageIcon({ noteId, fallback = null }: { noteId: string | null | undefined; fallback?: ReactNode }) {
  const query = useContext(QueryClientContext);
  const vault = useOptionalVaultClient();
  const override = usePageIconOverride(noteId);
  if (!noteId) return <>{fallback}</>;
  if (override !== undefined) return <PageIconView value={override} noteId={noteId} fallback={fallback} />;
  if (!query || !vault) return <>{fallback}</>;
  return <TreeIcon noteId={noteId} fallback={fallback} />;
}
