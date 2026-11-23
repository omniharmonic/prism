// DeleteAccountDialog — Settings → Account → "Delete account…" (App Store 5.1.1(v);
// docs/account-deletion.md). An in-app modal `<dialog>` (the apps' web views show no browser
// dialogs): it names the server, says what happens, asks for the account's email and — for a
// password account — its password, and only then calls `AccountClient.deleteAccount`.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

export interface DeleteAccountDialogProps {
  email: string;
  serverName: string;
  hasPassword: boolean;
  onDelete(input: { confirm: string; password?: string }): Promise<void>;
  onCancel(): void;
  /** Where the focus goes when the dialog closes (Safari does not focus a clicked button,
   *  so "whatever had the focus before" is not always the button that opened it). */
  returnFocus?(): HTMLElement | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function DeleteAccountDialog({ email, serverName, hasPassword, onDelete, onCancel, returnFocus }: DeleteAccountDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = same(typed, email) && (!hasPassword || password.length > 0) && !busy;

  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement;
    try { element?.showModal?.(); } catch { element?.setAttribute("open", ""); }
    first.current?.focus({ preventScroll: true });
    return () => {
      try { element?.close?.(); } catch { /* already closed */ }
      const back = returnFocus?.() ?? previous;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => { if (!busy) onCancel(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(hasPassword ? { confirm: typed.trim(), password } : { confirm: typed.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your account could not be deleted.");
      setBusy(false);
    }
  };

  const fieldClass = "focus-ring w-full min-h-control rounded-[var(--control-radius)] px-3 text-[13px]";
  const fieldStyle = { border: "1px solid var(--glass-border)", background: "var(--bg-base)", color: "var(--text-primary)" } as const;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-prism-delete-account=""
      // React bubbles `cancel` / `click` through the COMPONENT tree: this dialog sits inside the
      // Settings dialog, whose own Escape handler must not see this one's.
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); cancel(); }}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="m-auto w-[min(440px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-auto rounded-[20px] border border-[var(--glass-border)] bg-[var(--bg-elevated)] p-0 text-[var(--text-primary)] backdrop:bg-black/40"
      style={{ boxShadow: "var(--glass-shadow-elevated)" }}
    >
      <form className="p-5" onSubmit={(e) => void submit(e)} noValidate>
        <h2 id={titleId} className="m-0 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Delete your account?</h2>
        <div id={bodyId} className="mt-2 text-[13px] leading-snug" style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
          <p className="m-0">
            This deletes <strong style={{ color: "var(--text-primary)" }}>{email}</strong> on <strong style={{ color: "var(--text-primary)" }} data-testid="delete-account-server">{serverName}</strong>.
          </p>
          <ul className="mt-2 mb-0 pl-5" style={{ listStyle: "disc" }}>
            <li>You are signed out everywhere, and your devices and agent access tokens stop working.</li>
            <li>Your notifications, reminders and access to pages others shared with you are removed.</li>
            <li>Your private pages go to the server owner's Trash, where they can be restored or deleted.</li>
            <li>Pages you shared and your comments and edits in them stay, without your name.</li>
          </ul>
          <p className="mt-2 mb-0">This cannot be undone.</p>
        </div>
        <label htmlFor={emailId} className="mt-4 block text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>Type your email address to confirm</label>
        <input
          ref={first}
          id={emailId}
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
        {hasPassword && (
          <>
            <label htmlFor={passwordId} className="mt-3 block text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>Password</label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className={`${fieldClass} mt-1`}
              style={fieldStyle}
            />
          </>
        )}
        {error && <p id={errorId} role="alert" className="mt-3 mb-0 text-[13px]" style={{ color: "var(--color-danger, #c0392b)" }}>{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={cancel} disabled={busy} className="focus-ring min-h-control rounded-[var(--control-radius)] px-3 text-[13px] hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
            Cancel
          </button>
          <button type="submit" disabled={!ready} aria-disabled={!ready} className="focus-ring min-h-control rounded-[var(--control-radius)] px-3 text-[13px] font-semibold disabled:opacity-60"
            style={{ background: "var(--danger-bg, var(--color-danger))", color: "#fff" }}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
