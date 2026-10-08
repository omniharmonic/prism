import React, { useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Folder, MoreHorizontal } from "lucide-react";
import { queryKeys } from "../../lib/parachute/queries";
import type { Note } from "../../lib/types";
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
 * NP-PG-06: the header bar shows the breadcrumb. While the bar hosts the trail of
 * a page, the copy above that page's title is not drawn (one breadcrumb, not two).
 * Keyed by PATH so a row peek or a share page — whose page is not the bar's —
 * keeps its own.
 */
let hostedPath: string | null = null;
const hostedListeners = new Set<() => void>();
function setHostedPath(path: string | null) {
  if (hostedPath === path) return;
  hostedPath = path;
  hostedListeners.forEach((l) => l());
}
export function useHeaderBreadcrumbPath(): string | null {
  return useSyncExternalStore((l) => { hostedListeners.add(l); return () => { hostedListeners.delete(l); }; }, () => hostedPath, () => null);
}

/** How much of the trail the header bar has room for. */
export type CrumbRoom = "full" | "narrow" | "menu";

/**
 * The header bar's breadcrumb for the page in front (NP-PG-06): its ancestors, each
 * clickable and in the tab order, middle segments behind a “…” menu; with little
 * room only the menu; `phone` = the page's own name as the control (the bar's Back
 * button is the back affordance). Renders nothing for a top-level page. Needs a
 * query client and a vault client — the host mounts it only when both exist.
 */
export function HeaderBreadcrumb({ noteId, title, room, phone, onTrail }: { noteId: string; title: string; room: CrumbRoom; phone?: boolean; /** The trail shown changed (the host re-measures its room). */ onTrail?: (path: string) => void }) {
  const queries = useContext(QueryClientContext)!;
  const { data: tree } = useVaultTree();
  const cached = useSyncExternalStore(
    (notify) => queries.getQueryCache().subscribe(notify),
    () => queries.getQueryData<Note>(queryKeys.vault.note(noteId))?.path ?? null,
    () => null,
  );
  const path = cached ?? tree?.find((t) => t.id === noteId)?.path ?? null;
  const crumbs = crumbsFor(path);
  const hosting = crumbs.length > 0 ? path : null;
  useLayoutEffect(() => {
    setHostedPath(hosting);
    onTrail?.(hosting ?? "");
    return () => setHostedPath(null);
  }, [hosting, onTrail]);
  if (phone) return <PhoneCrumbs crumbs={crumbs} title={title} />;
  if (!crumbs.length) return null;
  return <LiveCrumbs crumbs={crumbs} room={room} bar />;
}

function useCrumbNavigation() {
  const { data: tree } = useVaultTree();
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
  return { pages, go };
}

/** Phone header: the page name; with ancestors it is a button that lists them. */
function PhoneCrumbs({ crumbs, title }: { crumbs: Crumb[]; title: string }) {
  const { pages, go } = useCrumbNavigation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!crumbs.length) return <span className="tabbar-phone-title truncate">{title}</span>;
  return (
    <nav className="tabbar-phone-crumbs" aria-label="Document location">
      <button
        type="button"
        className="tabbar-phone-title focus-ring"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={`${title} — show ${crumbs.length} location${crumbs.length === 1 ? "" : "s"}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="truncate">{title}</span>
        <ChevronDown size={13} aria-hidden="true" className="shrink-0" />
      </button>
      {menu && (
        <PageMenuPopover
          label="Locations"
          anchor={menu}
          onClose={() => setMenu(null)}
          items={crumbs.map((c) => ({
            id: c.raw,
            label: c.label,
            icon: pages.has(c.raw) ? <FileText size={15} /> : <Folder size={15} />,
            onClick: () => { setMenu(null); go(c); },
          }))}
        />
      )}
    </nav>
  );
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

function LiveCrumbs({ crumbs, room, bar }: { crumbs: Crumb[]; room?: CrumbRoom; bar?: boolean }) {
  const isMobile = useIsMobile();
  const [menu, setMenu] = useState<{ x: number; y: number; hidden: Crumb[] } | null>(null);
  const { pages, go } = useCrumbNavigation();
  const shown: Array<Crumb | { hidden: Crumb[] }> = room === "menu" ? [{ hidden: crumbs }] : visibleCrumbs(crumbs, room ? room === "narrow" : isMobile);
  const all = shown.length === 1 && "hidden" in shown[0]!;
  return (
    <nav className={bar ? "page-breadcrumb tabbar-crumbs" : "document-breadcrumb page-breadcrumb"} aria-label="Document location" data-room={room}>
      {!bar && <Folder size={14} aria-hidden="true" className="shrink-0" />}
      {shown.map((c, i) => (
        <React.Fragment key={"hidden" in c ? "…" : c.raw}>
          {i > 0 && <ChevronRight size={12} aria-hidden="true" className="page-crumb-sep" />}
          {"hidden" in c ? (
            <button
              type="button"
              className="page-crumb focus-ring"
              aria-label={`Show ${c.hidden.length} ${all ? "" : "more "}location${c.hidden.length === 1 ? "" : "s"}`}
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
      {bar && <ChevronRight size={12} aria-hidden="true" className="page-crumb-sep" />}
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
