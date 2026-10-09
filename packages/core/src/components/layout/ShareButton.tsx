import { useEffect, useRef, useState } from "react";
import { Share2, Check, Copy, X } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useCollabSharing } from "../../data/CollabSharing";
import { openSharingDialog } from "./SharingDialogHost";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { copyText } from "../../lib/clipboard";

const VIRTUAL = new Set([
  "messages-dashboard",
  "calendar-dashboard",
  "vault-messages",
  "agent-activity",
  "agent-chat",
  "people",
  "home",
  "notifications",
]);

/** A note id that maps to a real Parachute note (not a tag/virtual/dashboard tab). */
function isShareable(noteId: string): boolean {
  if (noteId.startsWith("tag:")) return false;
  if (VIRTUAL.has(noteId)) return false;
  if (noteId.includes(":") && !/^\d/.test(noteId)) return false;
  return true;
}

/**
 * Share-to-collaborate control in the tab bar. Generates a capability link that
 * lets a collaborator edit just this note in real time — no vault access, no
 * exposure of the rest of the graph. Hidden unless a CollabSharing impl is
 * provided and a real note is active.
 */
export function ShareButton() {
  const sharing = useCollabSharing();
  const activeTabId = useUIStore((s) => s.activeTabId);
  const openTabs = useUIStore((s) => s.openTabs);
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  // "uncopied": the link exists but the clipboard refused it — it is shown, selected, to copy by hand.
  const [status, setStatus] = useState<"idle" | "working" | "copied" | "uncopied" | "error">("idle");
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => {
    if (status === "uncopied") field.current?.select();
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!sharing || !activeTab || !isShareable(activeTab.noteId)) return null;
  const noteId = activeTab.noteId;

  // Rich ACL (web → Prism Server gateway): open the full Google-Docs-style
  // share dialog instead of the one-shot legacy link dropdown.
  if (sharing.getAccess) return <RichShareButton noteId={noteId} />;

  function showCopy(ok: boolean) {
    setStatus(ok ? "copied" : "uncopied");
    if (ok) setTimeout(() => setStatus((s) => (s === "copied" ? "idle" : s)), 2000);
  }

  function generate() {
    const mine = ++request.current;
    setOpen(true);
    setStatus("working");
    setLink(null);
    // The link comes from the server, but the clipboard only accepts a write that starts inside
    // this click: hand the PENDING link to copyText now (lib/clipboard.ts), then show the outcome.
    const pending = (async () => sharing!.createShareLink(noteId))();
    const written = copyText(pending);
    void (async () => {
      let url: string;
      try {
        url = await pending;
      } catch {
        if (mine === request.current) setStatus("error");
        return;
      }
      if (mine !== request.current) return;
      setLink(url);
      setStatus("idle");
      const ok = await written;
      if (mine === request.current) showCopy(ok);
    })();
  }

  function copy() {
    if (!link) return;
    const mine = request.current;
    void copyText(link).then((ok) => {
      if (mine === request.current) showCopy(ok);
    });
  }

  return (
    <div ref={ref} className="relative h-full">
      <button
        onClick={() => (open ? setOpen(false) : generate())}
        className="share-trigger px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
        title="Share for collaboration"
      >
        <Share2 size={15} style={{ color: "var(--text-muted)" }} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 glass-elevated rounded-lg p-3"
          style={{ width: 320, border: "1px solid var(--glass-border)" }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
              Share for live collaboration
            </span>
            <button onClick={() => setOpen(false)} className="p-0.5 rounded hover:bg-[var(--glass-hover)]">
              <X size={13} style={{ color: "var(--text-muted)" }} />
            </button>
          </div>

          {status === "working" && (
            <p className="text-xs py-2" style={{ color: "var(--text-muted)" }}>Creating link…</p>
          )}
          {status === "error" && (
            <p className="text-xs py-2" style={{ color: "var(--color-danger, #EB5757)" }}>
              Couldn’t create a share link.
            </p>
          )}

          {link && (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  ref={field}
                  readOnly
                  aria-label="Share link"
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 text-xs px-2 py-1.5 rounded outline-none"
                  style={{
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    color: "var(--text-secondary)",
                  }}
                />
                <button
                  onClick={copy}
                  className="px-2 py-1.5 rounded text-xs flex items-center gap-1"
                  style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
                >
                  {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
                  {status === "copied" ? "Copied" : "Copy"}
                </button>
                <span className="sr-only" aria-live="polite" aria-atomic="true">{status === "copied" ? "Link copied" : ""}</span>
              </div>
              {status === "uncopied" && (
                <p role="alert" className="text-[11px] mt-2" style={{ color: "var(--color-danger, #EB5757)" }}>
                  Couldn’t copy — the link above is selected; copy it by hand.
                </p>
              )}
              <p className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
                Anyone with this link can edit <strong>this note only</strong> — the rest of your
                vault stays private. Expires in 30 days.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Tab-bar share control backed by the full ACL dialog (web shell). */
function RichShareButton({ noteId }: { noteId: string }) {
  const isMobile = useIsMobile();
  // NP-PG-06: labelled "Share" on desktop; the phone header keeps the icon.
  return (
    <button
      onClick={() => openSharingDialog(noteId)}
      data-prism-share-trigger
      className={isMobile ? "share-trigger px-2 h-full hover:bg-[var(--glass-hover)] transition-colors" : "tabbar-labelled interactive focus-ring"}
      title="Share"
    >
      <Share2 size={15} style={{ color: isMobile ? "var(--text-muted)" : undefined }} aria-hidden={!isMobile || undefined} />
      {!isMobile && <span>Share</span>}
    </button>
  );
}
