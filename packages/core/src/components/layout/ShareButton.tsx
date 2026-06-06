import { useEffect, useRef, useState } from "react";
import { Share2, Check, Copy, X } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useCollabSharing } from "../../data/CollabSharing";
import { ShareDialog } from "./ShareDialog";

const VIRTUAL = new Set([
  "messages-dashboard",
  "calendar-dashboard",
  "vault-messages",
  "agent-activity",
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
  const [status, setStatus] = useState<"idle" | "working" | "copied" | "error">("idle");
  const ref = useRef<HTMLDivElement>(null);

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

  async function generate() {
    setOpen(true);
    setStatus("working");
    setLink(null);
    try {
      const url = await sharing!.createShareLink(noteId);
      setLink(url);
      setStatus("idle");
      try {
        await navigator.clipboard.writeText(url);
        setStatus("copied");
        setTimeout(() => setStatus("idle"), 2000);
      } catch {
        /* clipboard may be blocked; the link is shown to copy manually */
      }
    } catch {
      setStatus("error");
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div ref={ref} className="relative h-full">
      <button
        onClick={() => (open ? setOpen(false) : generate())}
        className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
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
                  readOnly
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
                  style={{ background: "var(--color-accent)", color: "white" }}
                >
                  {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
                  {status === "copied" ? "Copied" : "Copy"}
                </button>
              </div>
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
  const sharing = useCollabSharing();
  const [open, setOpen] = useState(false);
  if (!sharing) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-2 h-full hover:bg-[var(--glass-hover)] transition-colors"
        title="Share"
      >
        <Share2 size={15} style={{ color: "var(--text-muted)" }} />
      </button>
      {open && <ShareDialog noteId={noteId} sharing={sharing} onClose={() => setOpen(false)} />}
    </>
  );
}
