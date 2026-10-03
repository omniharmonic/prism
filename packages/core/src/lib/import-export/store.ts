/** Which import / export surface is open (mounted once by `ImportExportHost` in the Shell). */
import { create } from "zustand";

export interface ExportTarget {
  scope: "page" | "vault";
  /** Page scope. */
  page?: { id: string; title: string; path: string | null };
}

interface TransferUI {
  exporting: ExportTarget | null;
  importing: { parent?: string } | null;
  openExport: (target: ExportTarget | null) => void;
  openImport: (opts: { parent?: string } | null) => void;
}

export const useTransferUI = create<TransferUI>((set) => ({
  exporting: null,
  importing: null,
  openExport: (exporting) => set({ exporting, importing: null }),
  openImport: (importing) => set({ importing, exporting: null }),
}));

/** Print the open page (NP-TX-06). The print stylesheet (`styles/print.css`) removes the app chrome. */
export function printCurrentPage(): void {
  // Let an open menu close and repaint first, so it is not part of the printout.
  requestAnimationFrame(() => setTimeout(() => window.print(), 0));
}
