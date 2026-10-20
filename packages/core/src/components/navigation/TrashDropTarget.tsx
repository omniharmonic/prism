import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { usePageActions } from "../../lib/pages/usePageActions";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { protectionReason } from "../../lib/pages/model";

import { useVaultClient } from "../../data/VaultClientContext";
import { useScope } from "../../lib/database/hooks";
import { PAGE_DRAG_TYPE } from "../../lib/pages/drag";
export function TrashDropTarget() {
  const [over, setOver] = useState(false);
  const [page, setPage] = useState<PageRef | null>(null);
  const actions = usePageActions();
  const scope = useScope();
  const client = useVaultClient();
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  useEffect(() => { setPage(null); setPendingScope(null); setOver(false); }, [scope]);
  return <>
    <button type="button" className="workspace-trash-target focus-ring" data-drop-over={over || undefined}
      onClick={() => usePagesUI.getState().openTrash(true)}
      onDragOver={e => { if (!e.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={e => {
        setOver(false);
        if (!e.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return;
        e.preventDefault();
        try {
          const raw = e.dataTransfer.getData(PAGE_DRAG_TYPE);
          if (raw.length > 4096) return;
          const value = JSON.parse(raw);
          if (!scope || value.scope !== scope) return;
          setPendingScope(scope);
          if (typeof value.id !== "string" || !value.id || typeof value.path !== "string" || typeof value.title !== "string" || protectionReason(value)) return;
          setPage({ id: value.id, path: value.path, title: value.title });
        } catch { /* An incomplete or foreign drag is not a page. */ }
      }}>
      <Trash2 size={16} aria-hidden="true" /><span>{over ? "Drop to move to Trash" : "Trash"}</span>
    </button>
    {page && <ConfirmDialog title={`Move “${page.title}” to Trash?`} body="Its sub-pages move with it. You can restore them from Trash." confirm="Move to Trash" danger
      onCancel={() => setPage(null)} onConfirm={() => { const target = page; setPage(null); if (scope && pendingScope === scope && (!client.scope || client.scope() === pendingScope)) void actions.trash(target); }} />}
  </>;
}
