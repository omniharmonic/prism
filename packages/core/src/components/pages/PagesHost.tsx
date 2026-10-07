import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { createUntitledPage } from "../../lib/pages/quickCreate";
import { BottomSheet } from "../ui/BottomSheet";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { MovePageDialog } from "./MovePageDialog";
import { TrashDialog } from "./TrashDialog";
import { TemplatesGallery } from "./TemplatesGallery";
import { usePageMenuItems } from "./PageActionsMenu";
import "./pages.css";

/** Mounted once in the Shell: the page dialogs, the phone actions sheet and the toast. */
export function PagesHost() {
  const movePage = usePagesUI((s) => s.movePage);
  const trashOpen = usePagesUI((s) => s.trashOpen);
  const create = usePagesUI((s) => s.create);
  const actionsFor = usePagesUI((s) => s.actionsFor);
  const templatesOpen = usePagesUI((s) => s.templatesOpen);
  const ui = usePagesUI.getState();
  return (
    <>
      {movePage && <MovePageDialog page={movePage} onClose={() => ui.openMove(null)} />}
      {trashOpen && <TrashDialog onClose={() => ui.openTrash(false)} />}
      {/* NP-SB-13: "+" on a tree row, "Add a page inside", Home and ⌘N create the
          page at once; only "from template" (or a failed create) opens the dialog. */}
      {templatesOpen && <TemplatesGallery onClose={() => ui.openTemplates(false)} />}
      {create && (create.template || create.chooser || create.use
        ? <NewContentMenu key={create.use?.id ?? "new"} initialFolder={create.folder} startWithTemplates={create.template} initialTemplate={create.use} onClose={() => ui.openCreate(null)} />
        : <QuickCreate key={create.folder ?? ""} folder={create.folder} />)}
      {actionsFor && <PageActionsSheet page={actionsFor} onClose={() => ui.openActions(null)} />}
      <PageToastView />
    </>
  );
}

function PageActionsSheet({ page, onClose }: { page: PageRef; onClose: () => void }) {
  const items = usePageMenuItems(page, { close: onClose, sheet: true });
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={page.title}
      items={items.map((i) => ({ icon: i.icon, label: i.label, onClick: i.onClick, danger: i.danger, startsGroup: i.startsGroup, detail: i.disabled ? i.detail ?? "Not available for this page" : i.hint }))
        .filter((_, idx) => !items[idx]!.disabled)}
    />
  );
}

function PageToastView() {
  const toast = usePagesUI((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="page-toast" role={toast.tone === "error" ? "alert" : "status"} data-tone={toast.tone ?? "info"}>
      <span>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="focus-ring"
          onClick={() => {
            usePagesUI.getState().dismissToast(toast.id);
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      {toast.secondary && (
        <button
          type="button"
          className="focus-ring"
          onClick={() => {
            usePagesUI.getState().dismissToast(toast.id);
            toast.secondary!.run();
          }}
        >
          {toast.secondary.label}
        </button>
      )}
      <button type="button" className="focus-ring" aria-label="Dismiss" onClick={() => usePagesUI.getState().dismissToast(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

function QuickCreate({ folder }: { folder?: string }) {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice: still ONE page
    started.current = true;
    const ui = usePagesUI.getState();
    createUntitledPage(client, queryClient, folder === undefined ? {} : { folder })
      .then(() => ui.openCreate(null), () => ui.openCreate({ folder, chooser: true }));
  }, [client, queryClient, folder]);
  return null;
}
