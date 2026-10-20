import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCollabSharing } from "../../data/CollabSharing";
import { transferAvailable } from "../../lib/import-export/client";
import { printCurrentPage, useTransferUI } from "../../lib/import-export/store";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { CsvNewDatabaseDialog } from "../database/Csv";
import { useUIStore } from "../../app/stores/ui";

/**
 * Who may import / export the whole workspace: the owner and admins of the
 * active vault, in a shell that talks to a Prism Server. False while unknown —
 * the server enforces it either way; this only decides which entries appear.
 */
export function useCanManageTransfers(): boolean {
  const sharing = useCollabSharing();
  const query = useQuery({
    queryKey: ["transfer-viewer-role"],
    enabled: transferAvailable() && !!sharing?.getViewer,
    queryFn: () => sharing!.getViewer!(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return query.data?.role === "owner" || query.data?.role === "admin";
}

/** Mounted once in the Shell: the import and export dialogs, and ⌘P where the shell has no print shortcut of its own. */
export function ImportExportHost() {
  const exporting = useTransferUI((s) => s.exporting);
  const importing = useTransferUI((s) => s.importing);
  const csvDatabase = useTransferUI((s) => s.csvDatabase);
  useEffect(() => {
    // Browsers print on ⌘P/Ctrl+P themselves; the native shell's webview does not.
    if (!("__PRISM_HOST__" in window) && !("__TAURI_INTERNALS__" in window)) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        printCurrentPage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      {exporting && <ExportDialog key={`${exporting.scope}:${exporting.page?.id ?? ""}`} target={exporting} onClose={() => useTransferUI.getState().openExport(null)} />}
      {importing && <ImportDialog parent={importing.parent} onClose={() => useTransferUI.getState().openImport(null)} />}
      {/* DB-25: one CSV as a NEW database, with typed columns (the database group's dialog). */}
      {csvDatabase && (
        <CsvNewDatabaseDialog
          folder={csvDatabase.folder}
          onClose={() => useTransferUI.getState().openCsvDatabase(null)}
          onCreated={(note, title) => useUIStore.getState().openTab(note.id, title, "database" as never)}
        />
      )}
    </>
  );
}
