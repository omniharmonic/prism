import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DevicePairingClient, DevicePairingStart, DevicePairingView } from "../../../data/CollabSharing";
import { encodeQr, qrSvgPath } from "../../../lib/qr/qrcode";

/**
 * "Pair a phone" (QR pairing, D-G; docs/native-auth.md § Pairing).
 *
 * Shows a QR code the phone's Camera opens in Prism; the phone then shows a 4-digit code, the
 * owner types it here and approves. The phone receives an ordinary device token (it appears
 * under Signed-in devices). The QR holds this server's address and a one-time code that works
 * for 5 minutes, once; closing the dialog cancels it.
 */

const QUIET = 4;
const OPEN = new Set(["pending", "claimed", "approved"]);

function errorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" ? c : undefined;
}

const ENDED: Record<string, string> = {
  contested: "Someone else used this code as well, so it was cancelled. Start again, and only scan it with your own phone.",
  denied: "You declined this phone. Nothing was signed in.",
  failed: "This pairing was cancelled after a wrong code. Nothing was signed in.",
  expired: "This code expired before the phone was approved. Start again.",
  replaced: "A newer pairing code replaced this one.",
};

export function PairPhoneDialog({ client, onClose, onPaired, pollMs = 1500, returnFocus }: { client: DevicePairingClient; onClose: () => void; onPaired?: () => void; pollMs?: number; returnFocus?: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const codeId = useId();
  const [started, setStarted] = useState<DevicePairingStart | null>(null);
  const [view, setView] = useState<DevicePairingView | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [decideError, setDecideError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  /** Each start (and each unmount) moves this on: an answer for an older start is dropped. */
  const gen = useRef(0);
  const current = useRef<{ id: string; status: string } | null>(null);
  const paired = useRef(false);

  const start = useCallback(async () => {
    setStartError(null);
    setView(null);
    setStarted(null);
    setCode("");
    setDecideError(null);
    const mine = ++gen.current;
    try {
      const s = await client.start();
      if (!live.current || mine !== gen.current) {
        void client.decide(s.pairingId, "deny").catch(() => {});
        return;
      }
      setStarted(s);
      current.current = { id: s.pairingId, status: "pending" };
    } catch (e) {
      if (!live.current || mine !== gen.current) return;
      setStartError(
        errorCode(e) === "not_reachable"
          ? "This server answers on this computer only, so a phone can't reach it yet. Finish “Reachable from other devices” first."
          : errorCode(e) === "rate_limited"
            ? "Too many pairing codes in a short time. Wait a few minutes and try again."
            : "A pairing code could not be made. Check that the server is running and try again.",
      );
    }
  }, [client]);

  useEffect(() => {
    live.current = true;
    const element = ref.current;
    // Safari does not focus a clicked button, so the opener says where focus goes back.
    const previous = returnFocus ?? document.activeElement;
    try { element?.showModal?.(); } catch { element?.setAttribute("open", ""); }
    void start();
    return () => {
      live.current = false;
      gen.current++;
      try { element?.close?.(); } catch { /* already closed */ }
      // Closing cancels a pairing that is still open: the code must not outlive the dialog.
      const c = current.current;
      if (c && OPEN.has(c.status)) void client.decide(c.id, "deny").catch(() => {});
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the pairing while it is open: the phone's claim and the end arrive by themselves.
  useEffect(() => {
    if (!started) return;
    let stop = false;
    const read = async () => {
      try {
        const v = await client.get(started.pairingId);
        if (stop || !live.current) return;
        setView(v);
        current.current = { id: v.id, status: v.status };
        if (v.status === "completed" && !paired.current) {
          paired.current = true;
          onPaired?.();
        }
      } catch {
        /* keep the last answer; the next read tries again */
      }
    };
    void read();
    const t = window.setInterval(() => { if (!current.current || OPEN.has(current.current.status)) void read(); }, pollMs);
    return () => { stop = true; window.clearInterval(t); };
  }, [started, client, pollMs, onPaired]);

  const qr = useMemo(() => (started ? encodeQr(started.link) : null), [started]);
  const status = view?.status ?? (started ? "pending" : null);
  const needsDevice = view?.approveNeedsDevice ?? started?.approveNeedsDevice ?? false;

  const decide = async (decision: "approve" | "deny") => {
    if (!started) return;
    setBusy(true);
    setDecideError(null);
    try {
      await client.decide(started.pairingId, decision, decision === "approve" ? code : undefined);
      const v = await client.get(started.pairingId).catch(() => null);
      if (v && live.current) { setView(v); current.current = { id: v.id, status: v.status }; }
    } catch (e) {
      const c = errorCode(e);
      setDecideError(
        c === "wrong_check_code"
          ? "That code doesn't match the phone. Check the 4 digits on the phone and try again."
          : c === "device_required"
            ? "Approve this phone from the Prism app on a device you already use."
            : c === "too_many_tries"
              ? "Too many wrong codes. This pairing was cancelled."
              : "That didn't work. The pairing may have ended — start again if it did.",
      );
      const v = await client.get(started.pairingId).catch(() => null);
      if (v && live.current) { setView(v); current.current = { id: v.id, status: v.status }; }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const size = qr ? qr.size + QUIET * 2 : 0;
  const announce = startError
    ? startError
    : !started
      ? "Making a pairing code."
      : status === "pending"
        ? "Pairing code ready. Scan it with your phone's camera."
        : status === "claimed"
          ? "A phone scanned the code and is waiting for your approval."
          : status === "approved"
            ? "Approved. Finishing on the phone."
            : status === "completed"
              ? "The phone is signed in."
              : (status && ENDED[status]) || "";
  const label = view?.label ?? "";
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-prism-pair=""
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="prism-pair m-auto w-[min(400px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-auto rounded-[20px] border border-[var(--glass-border)] bg-[var(--bg-elevated)] p-0 text-[var(--text-primary)] backdrop:bg-black/40"
      style={{ boxShadow: "var(--glass-shadow-elevated)" }}
    >
      <div className="p-5">
        <h2 id={titleId} className="m-0 text-sm font-semibold">Pair a phone</h2>
        <p role="status" className="sr-only">{announce}</p>
        <div className="prism-pair-body">
          {startError && <p className="prism-pair-note">{startError}</p>}
          {!startError && !started && <p className="prism-pair-note">Making a pairing code…</p>}
          {started && status === "pending" && qr && (
            <>
              <p className="prism-pair-note">On your iPhone or iPad, open the Camera and point it at this code. Prism opens and shows a 4-digit code — type it here.</p>
              <svg className="prism-pair-qr" role="img" aria-label={`Pairing code for ${started.origin}`} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" data-qr-version={qr.version}>
                <rect width={size} height={size} fill="#fff" />
                <path d={qrSvgPath(qr, QUIET)} fill="#000" />
              </svg>
              <p className="prism-pair-small">For {started.origin}. Works once, for 5 minutes. Don't share it: whoever scans it can ask to sign in as you.</p>
            </>
          )}
          {started && status === "claimed" && (
            <>
              <p className="prism-pair-note">A device calling itself “{label}” wants to sign in to Prism as you. If you approve, it will see and edit exactly what you can.</p>
              {needsDevice ? (
                <p className="prism-pair-note" data-needs-device="">You already have a device signed in, so this phone must be approved from it: open this checklist in the Prism app on that device. You can decline here.</p>
              ) : (
                <form
                  className="prism-pair-form"
                  onSubmit={(e) => { e.preventDefault(); if (/^\d{4}$/.test(code) && !busy) void decide("approve"); }}
                >
                  <label htmlFor={codeId}>Code shown on the phone</label>
                  <input
                    id={codeId}
                    value={code}
                    onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setDecideError(null); }}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    aria-invalid={decideError ? true : undefined}
                    aria-describedby={decideError ? `${codeId}-error` : undefined}
                    className="focus-ring"
                    autoFocus
                  />
                  {decideError && <p id={`${codeId}-error`} className="prism-pair-error">{decideError}</p>}
                  <div className="prism-pair-actions">
                    <button type="button" className="focus-ring" onClick={() => void decide("deny")} disabled={busy}>Decline</button>
                    <button type="submit" className="focus-ring prism-pair-primary" disabled={busy || !/^\d{4}$/.test(code)}>Approve</button>
                  </div>
                </form>
              )}
              {needsDevice && (
                <div className="prism-pair-actions">
                  <button type="button" className="focus-ring" onClick={() => void decide("deny")} disabled={busy}>Decline</button>
                </div>
              )}
            </>
          )}
          {started && status === "approved" && <p className="prism-pair-note">Approved. Finishing on the phone…</p>}
          {started && status === "completed" && <p className="prism-pair-note">“{label}” is signed in. You'll find it under Settings → Account → Signed-in devices.</p>}
          {started && status && ENDED[status] && <p className="prism-pair-note">{ENDED[status]}</p>}
        </div>
        <div className="prism-pair-actions">
          {(startError || (status && ENDED[status])) && <button type="button" className="focus-ring" onClick={() => void start()}>Start again</button>}
          <button type="button" className="focus-ring" onClick={onClose}>{status === "completed" ? "Done" : "Close"}</button>
        </div>
      </div>
    </dialog>
  );
}
