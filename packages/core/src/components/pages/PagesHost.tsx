import { X } from "lucide-react";
import { BottomSheet } from "../ui/BottomSheet";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { MovePageDialog } from "./MovePageDialog";
import { TrashDialog } from "./TrashDialog";
import { usePageMenuItems } from "./PageActionsMenu";
import "./pages.css";

/** Mounted once in the Shell: the page dialogs, the phone actions sheet and the toast. */
export function PagesHost() {
  const movePage = usePagesUI((s) => s.movePage);
  const trashOpen = usePagesUI((s) => s.trashOpen);
  const create = usePagesUI((s) => s.create);
  const actionsFor = usePagesUI((s) => s.actionsFor);
  const ui = usePagesUI.getState();
  return (
    <>
      {movePage && <MovePageDialog page={movePage} onClose={() => ui.openMove(null)} />}
      {trashOpen && <TrashDialog onClose={() => ui.openTrash(false)} />}
      {create && <NewContentMenu initialFolder={create.folder} startWithTemplates={create.template} onClose={() => ui.openCreate(null)} />}
      {actionsFor && <PageActionsSheet page={actionsFor} onClose={() => ui.openActions(null)} />}
      <PageToastView />
    </>
  );
}

function PageActionsSheet({ page, onClose }: { page: PageRef; onClose: () => void }) {
  const items = usePageMenuItems(page, { close: onClose });
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={page.title}
      items={items.map((i) => ({ icon: i.icon, label: i.label, onClick: i.onClick, danger: i.danger, startsGroup: i.startsGroup, detail: i.disabled ? i.detail ?? "Not available for this page" : undefined }))
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
      <button type="button" className="focus-ring" aria-label="Dismiss" onClick={() => usePagesUI.getState().dismissToast(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
