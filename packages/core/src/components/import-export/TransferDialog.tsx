import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "../pages/pages.css";
import "./import-export.css";

/** The modal frame both dialogs share: focus in, Esc/backdrop out (unless busy), focus back. */
export function TransferDialog({ title, subtitle, labelId, busy, onClose, children }: {
  title: string;
  subtitle?: string;
  labelId: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (node && !node.open) node.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="page-dialog"
      aria-labelledby={labelId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="page-dialog-inner">
        <div className="page-dialog-head">
          <div className="min-w-0">
            <h2 id={labelId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="page-dialog-close focus-ring" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="transfer-progress">
      <div className="transfer-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={Math.min(done, total || 1)}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <p role="status">{label}</p>
    </div>
  );
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
