import React, { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder, MoreHorizontal } from "lucide-react";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { inferContentType } from "../../lib/schemas/content-types";
import { usePagesUI } from "../../lib/pages/store";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { PageMenuPopover } from "./PageActionsMenu";
import { PageIcon } from "../../lib/pages/icons";
import "./pages.css";

interface Crumb {
  label: string;
  raw: string;
}

/** The ancestors of a page path (raw, so they match vault paths), outermost first. */
export function crumbsFor(path: string | null | undefined): Crumb[] {
  if (!path) return [];
  const prefix = path.startsWith("vault/") ? "vault/" : "";
  const parts = path.slice(prefix.length).split("/").filter(Boolean);
  return parts.slice(0, -1).map((label, i) => ({ label, raw: prefix + parts.slice(0, i + 1).join("/") }));
}

/** Which crumbs show: all of a short trail; first, “…” and the last two (last one on a phone) otherwise. */
export function visibleCrumbs(crumbs: Crumb[], narrow: boolean): Array<Crumb | { hidden: Crumb[] }> {
  const keep = narrow ? 1 : 2;
  if (crumbs.length <= keep + 1) return crumbs;
  const head = narrow ? [] : [crumbs[0]!];
  const hidden = crumbs.slice(head.length, crumbs.length - keep);
  return [...head, { hidden }, ...crumbs.slice(crumbs.length - keep)];
}

/**
 * Breadcrumbs above a page: every ancestor is navigable — a parent PAGE opens, a
 * plain folder is revealed in the sidebar. Long trails collapse into “…”.
 * Static (display-only) without a query client or vault client, e.g. standalone header previews.
 */
export function PageBreadcrumbs({ path }: { path?: string | null }) {
  const client = useContext(QueryClientContext);
  const vault = useOptionalVaultClient();
  const crumbs = crumbsFor(path);
  if (!crumbs.length) return null;
  return client && vault ? <LiveCrumbs crumbs={crumbs} /> : <StaticCrumbs crumbs={crumbs} />;
}

function StaticCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="document-breadcrumb page-breadcrumb" aria-label="Document location">
      <Folder size={14} aria-hidden="true" className="shrink-0" />
      {crumbs.map((c, i) => (
        <React.Fragment key={c.raw}>
          {i > 0 && <ChevronRight size={12} aria-hidden="true" className="page-crumb-sep" />}
          <span title={c.label} className="document-breadcrumb-part page-crumb">
            {c.label}
          </span>
        </React.Fragment>
      ))}
    </nav>
  );
}

function LiveCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const { data: tree } = useVaultTree();
  const isMobile = useIsMobile();
  const [menu, setMenu] = useState<{ x: number; y: number; hidden: Crumb[] } | null>(null);
  const pages = new Map((tree ?? []).filter((t) => t.path).map((t) => [t.path!, t]));
  const go = (c: Crumb) => {
    const page = pages.get(c.raw);
    if (page) {
      useUIStore.getState().openTab(page.id, c.label, inferContentType(page));
      return;
    }
    usePagesUI.getState().reveal(c.raw);
    if (!useUIStore.getState().sidebarOpen) useUIStore.getState().toggleSidebar();
  };
  const shown = visibleCrumbs(crumbs, isMobile);
  return (
    <nav className="document-breadcrumb page-breadcrumb" aria-label="Document location">
      <Folder size={14} aria-hidden="true" className="shrink-0" />
      {shown.map((c, i) => (
        <React.Fragment key={"hidden" in c ? "…" : c.raw}>
          {i > 0 && <ChevronRight size={12} aria-hidden="true" className="page-crumb-sep" />}
          {"hidden" in c ? (
            <button
              type="button"
              className="page-crumb focus-ring"
              aria-label={`Show ${c.hidden.length} more location${c.hidden.length === 1 ? "" : "s"}`}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4, hidden: c.hidden });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="document-breadcrumb-part page-crumb focus-ring"
              title={pages.has(c.raw) ? `Open ${c.label}` : `Show ${c.label} in the sidebar`}
              onClick={() => go(c)}
            >
              <PageIcon noteId={pages.get(c.raw)?.id} />
              {c.label}
            </button>
          )}
        </React.Fragment>
      ))}
      {menu && (
        <PageMenuPopover
          label="More locations"
          anchor={menu}
          onClose={() => setMenu(null)}
          items={menu.hidden.map((c) => ({
            id: c.raw,
            label: c.label,
            icon: pages.has(c.raw) ? <FileText size={15} /> : <Folder size={15} />,
            onClick: () => {
              setMenu(null);
              go(c);
            },
          }))}
        />
      )}
    </nav>
  );
}
