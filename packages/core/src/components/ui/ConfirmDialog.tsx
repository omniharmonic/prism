import { useEffect, useId, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The ONE in-app confirmation / message dialog.
 *
 * Why it exists: the Prism Client's web view (Tauri / wry, macOS and iOS) implements
 * no JavaScript-dialog delegate, so `window.confirm()` answers `false`, `window.prompt()`
 * answers `null` and `window.alert()` shows nothing — every action behind one silently
 * did nothing in the apps. Shipped UI never calls them (`scripts/check-no-browser-dialogs.mjs`).
 *
 * A modal `<dialog>` (top layer): it sits above Settings and every other modal dialog,
 * traps the focus, and Escape answers "no".
 *
 *  - `<ConfirmDialog …/>` — controlled, for a component that keeps its own "asking" state.
 *  - `askConfirm({…})` → `Promise<boolean>` and `showMessage(…)` → `Promise<void>` —
 *    self-mounting (their own root on <body>, like the shortcut sheet), for call sites
 *    that used to block on `confirm()` / `alert()`.
 */
export interface ConfirmOptions {
  title: string;
  /** Plain text; line breaks are kept. */
  body?: string;
  /** Label of the button that means "yes". Default "Confirm". */
  confirm?: string;
  /** Label of the other button. `null` = a message with one button. Default "Cancel". */
  cancel?: string | null;
  /** A destructive action: the yes button is red and Cancel takes the focus. */
  danger?: boolean;
}

export function ConfirmDialog({ title, body, confirm = "Confirm", cancel = "Cancel", danger = false, onConfirm, onCancel }: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement;
    try { element?.showModal?.(); } catch { element?.setAttribute("open", ""); }
    (danger && cancel !== null ? no.current : yes.current)?.focus({ preventScroll: true });
    return () => {
      try { element?.close?.(); } catch { /* already closed */ }
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      data-prism-confirm=""
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="m-auto w-[min(360px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-auto rounded-xl border border-[var(--glass-border)] bg-[var(--bg-elevated)] p-0 text-[var(--text-primary)] backdrop:bg-black/40"
      style={{ boxShadow: "var(--glass-shadow-elevated)" }}
    >
      <div className="p-4">
        <h2 id={titleId} className="m-0 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
        {body && <p id={bodyId} className="mt-2 mb-0 text-[13px] leading-snug" style={{ color: "var(--text-secondary)", whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{body}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {cancel !== null && (
            <button ref={no} type="button" onClick={onCancel} className="focus-ring min-h-control rounded-md px-3 text-[13px] hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
              {cancel}
            </button>
          )}
          <button ref={yes} type="button" onClick={onConfirm} className="focus-ring min-h-control rounded-md px-3 text-[13px] font-semibold"
            style={{ background: danger ? "var(--danger-bg, var(--color-danger))" : "var(--action-bg, var(--color-accent))", color: danger ? "#fff" : "var(--action-fg, #fff)" }}>
            {confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queue: Promise<unknown> = Promise.resolve();

function present(options: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  const run = () => new Promise<boolean>((resolve) => {
    if (!host) { host = document.createElement("div"); host.dataset.prismConfirmHost = ""; document.body.appendChild(host); root = createRoot(host); }
    const done = (answer: boolean) => { root?.render(null); resolve(answer); };
    // A fresh key per question: the dialog mounts (and takes the focus) every time.
    root!.render(<ConfirmDialog key={Date.now() + Math.random()} {...options} onConfirm={() => done(true)} onCancel={() => done(false)} />);
  });
  // One question at a time; a second one waits for the first answer.
  const next = queue.then(run, run);
  queue = next;
  return next;
}

/** Ask a yes / no question in the app. Resolves `true` only on the confirm button. */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return present(options);
}

/** Tell the person something that needs reading (what `alert()` was used for). Resolves when dismissed. */
export function showMessage(body: string, title = "Prism"): Promise<void> {
  return present({ title, body, confirm: "OK", cancel: null }).then(() => undefined);
}
