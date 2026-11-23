import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  Copy,
  X,
  Link2,
  Trash2,
  Globe,
  Lock,
  Users,
  Radio,
} from "lucide-react";
import type {
  CollabSharing,
  NoteAccess,
  PeerInfo,
  PublicationInfo,
  ShareLevel,
  SharePerson,
} from "../../data/CollabSharing";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { PersonAvatar } from "../sharing/PersonAvatar";
import { PublishFlow } from "../sharing/PublishHandoff";

import { formatDate as fmtDate } from "../../lib/datetime/format";
import { copyText } from "../../lib/clipboard";
type Props = { noteId: string; sharing: CollabSharing; onClose: () => void };
type Section = "people" | "links" | "publish" | "sync";
const LEVELS: ShareLevel[] = ["view", "comment", "suggest", "edit"];
/** "full" = Full access: every capability (share, delete, organize, …). Admin-granted only. */
type Choice = ShareLevel | "full";
const FULL_CAPS = ["view", "comment", "suggest", "edit", "create", "organize", "delete", "share"];
const LABEL: Record<Choice, string> = {
  full: "Full access",
  view: "Can view",
  comment: "Can comment",
  suggest: "Can suggest",
  edit: "Can edit",
};
const isFull = (p: Pick<SharePerson, "caps">) => !!p.caps && FULL_CAPS.every((c) => p.caps!.includes(c));
const personName = (p: { name?: string | null; email?: string | null }) => p.name?.trim() || p.email || "Someone";
/** Suggest-only is enforced by the server (raw edits need edit; suggestions and
 *  comments go through server-authored commands), so no trust caveat is needed. */
const SUGGEST_HELP =
  "Propose edits and comment. Their changes wait for an editor’s review — they can’t change the page directly.";
const PEER_SUGGEST_HELP =
  "A peer with Can suggest can read this page but not change it: peers have no suggestion path yet.";
const HELP: Record<ShareLevel, string> = {
  view: "Read this document without changing it.",
  comment:
    "Read-only in the live editor. Anchored comments currently require Can suggest.",
  suggest: SUGGEST_HELP,
  edit: "Edit this document directly and review suggested changes.",
};
const isPrivateNote = (a: NoteAccess | null) => a?.note.visibility === "private";
const errorText = (e: unknown, fallback: string) =>
  e instanceof Error && /conflict|changed|Reconnect|409/i.test(e.message)
    ? "Access or the document changed. Reload sharing settings before trying again."
    : fallback;

/** Closing on an audience change prevents reusing a note ID in another vault. */
export function ShareDialog(props: Props) {
  const scope = useAgentChatStore((s) => s.scope);
  const initial = useRef(scope);
  useEffect(() => {
    if (scope !== initial.current) props.onClose();
  }, [scope, props.onClose]);
  return scope === initial.current ? (
    <SharingDocument key={props.noteId} {...props} />
  ) : null;
}

function SharingDocument({ noteId, sharing, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const lock = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const heading = useId();
  const [access, setAccess] = useState<NoteAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("people");
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<Choice>("view");
  const [withSubpages, setWithSubpages] = useState(true);
  const [linkLevel, setLinkLevel] = useState<ShareLevel>("view");
  const [days, setDays] = useState(30);
  const [copied, setCopied] = useState("");
  const [manualCopy, setManualCopy] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(
    null,
  );
  const [peers, setPeers] = useState<PeerInfo[] | null>(null);
  const [peer, setPeer] = useState("");
  const [peerLevel, setPeerLevel] = useState<ShareLevel>("edit");
  const [notice, setNotice] = useState("");
  const [publications, setPublications] = useState<PublicationInfo[] | null>(
    null,
  );
  const [tag, setTag] = useState("");
  const [publishedCount, setPublishedCount] = useState<number | null>(null);
  const admin = !!access && access.canManageLinks !== false;
  const levels = access?.allowedLevels ?? LEVELS;
  // Notion's ladder, strongest first; Full access only where the server lets this
  // caller grant every capability (administrators).
  const personChoices: Choice[] = [...(admin ? (["full"] as Choice[]) : []), ...[...levels].reverse()];
  const pageScope = !isPrivateNote(access) && withSubpages ? "page" : "note";
  const grant = (email: string, choice: Choice, scope: "page" | "note") =>
    sharing.setPerson!(noteId, email, choice === "full" ? "edit" : choice, {
      scope,
      ...(choice === "full" ? { caps: FULL_CAPS } : {}),
    });
  const isPrivate = access?.note.visibility === "private";
  const currentPub = publications?.find((p) => p.tag === tag);
  useEffect(() => {
    if (access?.canManageLinks === false) setSection("people");
  }, [access?.canManageLinks]);

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      alive.current = false;
      clearTimeout(copyTimer.current);
      element?.close();
      if (trigger?.isConnected && !trigger.matches("body, html")) trigger.focus();
      else
        document
          .querySelector<HTMLButtonElement>("button[data-prism-share-trigger]")
          ?.focus();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!sharing.getAccess) throw new Error("Sharing is unavailable.");
    const next = await sharing.getAccess(noteId);
    if (!alive.current) return;
    setAccess(next);
    setLevel((current) =>
      (current === "full" && next.canManageLinks !== false) ||
      (current !== "full" && (next.allowedLevels ?? LEVELS).includes(current))
        ? current
        : (next.allowedLevels?.[0] ?? "view"),
    );
    setTag((current) => current || next.note.tags[0] || "");
  }, [sharing, noteId]);
  useEffect(() => {
    void refresh().catch(() => {
      if (alive.current) setError("Couldn't load sharing settings. Try again.");
    });
  }, [refresh]);

  /** Resolves true when the action went through (false: refused, failed — the error is shown — or another one is running). */
  async function run(action: () => Promise<void>, fallback: string): Promise<boolean> {
    if (lock.current || !alive.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      return true;
    } catch (e) {
      if (alive.current) setError(errorText(e, fallback));
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function changed(action: () => Promise<unknown>) {
    await action();
    if (!alive.current) return;
    window.dispatchEvent(
      new CustomEvent("prism:acl-changed", { detail: { noteId } }),
    );
    try {
      await refresh();
    } catch {
      setAccess(null);
      throw new Error("Access changed; reload settings.");
    }
  }
  /** "Copied" only when the clipboard really took it; otherwise the link is shown to copy by hand. */
  function showCopy(ok: boolean, url: string, label: string) {
    if (!alive.current) return;
    clearTimeout(copyTimer.current);
    if (!ok) {
      setCopied("");
      setManualCopy({ url, label });
      return;
    }
    setCopied(label);
    setManualCopy(null);
    copyTimer.current = setTimeout(() => {
      if (alive.current) setCopied("");
    }, 2000);
  }
  /** Call synchronously in the click handler (lib/clipboard.ts: the write must start inside the gesture). */
  function copy(url: string, label: string) {
    void copyText(url).then((ok) => showCopy(ok, url, label));
  }
  /**
   * Create a link and copy it. The link comes from the server, but the clipboard only accepts a
   * write that starts inside this click, so the PENDING link goes to copyText right away.
   */
  function createLinkAndCopy() {
    if (lock.current || !alive.current) return;
    const pending = (async () => sharing.createLink!(noteId, linkLevel, days))();
    const written = copyText(pending.then((link) => link.url));
    void run(async () => {
      const link = await pending;
      if (!alive.current) return;
      await changed(async () => {});
      showCopy(await written, link.url, `link ${link.id}`);
    }, "Couldn't create the link.");
  }
  const loadPublications = useCallback(async () => {
    if (alive.current) setPublications(null);
    const rows = await sharing.listPublications?.();
    if (alive.current) setPublications(rows ?? []);
  }, [sharing]);
  useEffect(() => {
    if (section === "publish")
      void loadPublications().catch(() => {
        if (alive.current)
          setError(
            "Couldn't load published sites. Try again before publishing.",
          );
      });
    if (section === "sync") {
      setPeers(null);
      void sharing
        .listPeers?.()
        .then((rows) => {
          if (!alive.current) return;
          const paired = rows.filter((p) => p.pairedAt);
          setPeers(paired);
          setPeer((current) => current || paired[0]?.pubkey || "");
        })
        .catch(() => {
          if (alive.current) setError("Couldn't load paired peers.");
        });
    }
  }, [section, sharing, loadPublications]);
  function choose(next: Section) {
    setSection(next);
    setError("");
    setNotice("");
    setManualCopy(null);
  }
  const levelSelect = <T extends Choice>(
    value: T,
    change: (value: T) => void,
    label: string,
    options: readonly T[] = LEVELS as unknown as T[],
    custom = false,
    disabled = false,
  ) => (
    <select
      aria-label={label}
      disabled={disabled}
      value={custom ? "custom" : value}
      onChange={(e) => change(e.target.value as T)}
    >
      {custom && (
        <option value="custom" disabled>
          Custom permissions
        </option>
      )}
      {!custom && !options.includes(value) && (
        <option value={value} disabled>
          {LABEL[value]}
        </option>
      )}
      {options.map((l) => (
        <option key={l} value={l}>
          {LABEL[l]}
        </option>
      ))}
    </select>
  );
  const copyButton = (url: string, label: string) => (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => copy(url, label)}
    >
      {copied === label ? <Check size={16} /> : <Copy size={16} />}{" "}
      {copied === label ? "Copied" : "Copy"}
    </button>
  );
  const tabs: Array<{ id: Section; label: string; icon: ReactNode }> = [
    { id: "people", label: "People", icon: <Users size={16} /> },
    ...(admin
      ? [{ id: "links" as const, label: "Link access", icon: <Link2 size={16} /> }]
      : []),
    ...(admin && sharing.publishTag
      ? [
          {
            id: "publish" as const,
            label: "Publish",
            icon: <Globe size={16} />,
          },
        ]
      : []),
    ...(admin && sharing.mirrorNoteToPeer
      ? [{ id: "sync" as const, label: "Sync", icon: <Radio size={16} /> }]
      : []),
  ];

  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, a[href], [tabindex="0"]',
          ),
        ].filter(
          (el) => !el.matches(":disabled") && el.getClientRects().length,
        );
        // Safari can skip buttons in native tab order. Move explicitly through
        // the dialog's visible controls so focus cannot escape between them.
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[event.shiftKey
          ? (index <= 0 ? items.length - 1 : index - 1)
          : (index + 1) % items.length]?.focus();
      }}
      onCancel={onClose}
      className="prism-share-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <style>{`
      .prism-share-dialog { width:min(580px,calc(100vw - 24px)); max-height:calc(100dvh - 32px); margin:auto; padding:0; border:1px solid var(--border-default,var(--glass-border)); border-radius:16px; background:var(--bg-surface); color:var(--text-primary); box-shadow:0 24px 80px #0003; overflow:auto; }
      .prism-share-dialog::backdrop { background:#0005; }
      .prism-share-dialog button,.prism-share-dialog input,.prism-share-dialog select { min-height:var(--control-h-md); border-radius:8px; border:1px solid var(--glass-border); padding:5px var(--control-px-md); font:inherit; font-size:13px; background:var(--bg-surface); color:var(--text-primary); max-width:100%; }
      .prism-share-dialog button { display:inline-flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; }
      .prism-share-dialog button:disabled,.prism-share-dialog fieldset:disabled { opacity:.55; }
      .prism-share-dialog > header > button { width:var(--control-h-md); padding:0; border-color:transparent; background:transparent; color:var(--text-muted); }
      .prism-share-dialog > header > button:hover { background:var(--glass-hover); color:var(--text-primary); }
      .prism-share-dialog :focus-visible { outline:2px solid var(--color-accent); outline-offset:2px; }
      .prism-share-dialog p { margin:0; font-size:13px; line-height:1.6; color:var(--text-secondary); }
      .prism-share-dialog label { display:grid; grid-template-columns:minmax(0,1fr); gap:7px; font-size:12px; color:var(--text-secondary); }
      /* One column that may be NARROWER than its widest child (a select is as wide as its longest option; with a classic
         scrollbar in the dialog — Safari with a mouse — an auto column pushed the dialog sideways by the difference). */
      .prism-share-dialog .share-stack { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; }
      .prism-share-dialog select { max-width:100%; min-width:0; }
      .prism-share-dialog .share-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .prism-share-dialog .share-card { padding:14px; border:1px solid var(--glass-border); border-radius:10px; }
      .prism-share-dialog .share-primary { background:var(--action-bg, var(--color-accent)); color:var(--action-fg, #fff); border-color:transparent; }
      .prism-share-dialog h3 { font-size:13px; margin:0 0 8px; font-weight:600; }
      .prism-share-dialog .share-person { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; gap:10px; padding:8px 0; }
      .prism-share-dialog .share-person .share-who { min-width:0; display:grid; gap:1px; }
      .prism-share-dialog .share-person .share-who strong { font-size:13.5px; font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .prism-share-dialog .share-person .share-who small { font-size:12px; color:var(--text-muted); overflow-wrap:anywhere; }
      .prism-share-dialog .share-person .share-owner { font-size:12.5px; color:var(--text-muted); padding:0 4px; }
      .prism-share-dialog .share-tabs { display:flex; gap:20px; padding:0 20px; border-bottom:1px solid var(--glass-border); overflow-x:auto; }
      .prism-share-dialog .share-tabs button[role=tab] { border:0; border-radius:0; background:none; padding:6px 2px; min-height:var(--control-h-lg); margin-bottom:-1px; color:var(--text-secondary); border-bottom:2px solid transparent; font-weight:500; white-space:nowrap; }
      .prism-share-dialog .share-tabs button[role=tab]:hover { color:var(--text-primary); }
      .prism-share-dialog .share-tabs button[aria-selected=true] { color:var(--text-primary); border-bottom-color:var(--text-primary); font-weight:600; }
      .prism-share-dialog .share-subtle { font-size:12px; color:var(--text-muted); }
      .prism-share-dialog .share-check { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text-secondary); }
      .prism-share-dialog .share-check input { min-height:auto; width:16px; height:16px; padding:0; accent-color:var(--color-accent); }
      .prism-share-dialog .share-invite { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; }
      /* A person row is a line of text with two quiet controls, not a form row of boxes. */
      .prism-share-dialog .share-person select { border-color:var(--glass-border); background-color:transparent; color:var(--text-secondary); }
      .prism-share-dialog .share-person select:hover,.prism-share-dialog .share-person select:focus-visible { background-color:var(--glass-hover); color:var(--text-primary); }
      .prism-share-dialog .share-person button { border-color:transparent; background:transparent; color:var(--text-muted); min-width:var(--control-h-md); padding:6px; }
      .prism-share-dialog .share-person button:hover:not(:disabled) { background:var(--glass-hover); color:var(--color-danger); }
      /* Touch targets (touch.css condition): desktop draws the controls at the control-token size. */
      @media screen and (max-width:767px), screen and (hover:none) and (pointer:coarse) {
        .prism-share-dialog button,.prism-share-dialog input,.prism-share-dialog select,.prism-share-dialog .share-tabs button[role=tab] { min-height:var(--touch-target); }
        .prism-share-dialog > header > button { width:var(--touch-target); }
        .prism-share-dialog .share-person button { min-width:var(--touch-target); }
      }
      @media(max-width:480px) {
        .prism-share-dialog { width:100vw; max-width:100vw; margin:auto 0 0; border-radius:16px 16px 0 0; max-height:92dvh; border-bottom:0; }
        .prism-share-dialog .share-invite { grid-template-columns:1fr auto; }
        .prism-share-dialog .share-invite input { grid-column:1/-1; }
        .prism-share-dialog .share-person { gap:8px; }
        .prism-share-dialog .share-person select { max-width:124px; padding:8px; }
        .prism-share-dialog .share-tabs { gap:14px; padding:0 16px; }
      }
    `}</style>
      <header
        style={{
          padding: "20px 20px 12px",
          display: "flex",
          alignItems: "start",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id={heading} style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>
            <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Share document</span>
            <span aria-hidden>Share</span>
          </h2>
          <p style={{ overflowWrap: "anywhere", marginTop: 4 }}>
            {access?.note.title || "Manage collaboration and access"}
          </p>
        </div>
        <button type="button" aria-label="Close sharing" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div
        role="tablist"
        aria-label="Sharing options"
        className="share-tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const i = tabs.findIndex((t) => t.id === section);
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          if (!next) return;
          e.preventDefault();
          choose(next.id);
          e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            aria-selected={section === t.id}
            tabIndex={section === t.id ? 0 : -1}
            disabled={busy}
            onClick={() => choose(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ padding: 20 }} className="share-stack">
        {error && (
          <div role="alert" className="share-card">
            <p>{error}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await refresh();
                  if (section === "publish") await loadPublications();
                }, "Couldn't reload sharing settings.")
              }
            >
              Reload settings
            </button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {/* The Copy button only swaps its own label; say the outcome to a screen reader too. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="share-copy-status">{copied ? `${copied} copied` : ""}</span>
        {manualCopy && (
          <label>
            Clipboard unavailable. Select and copy this link.
            <input
              aria-label={manualCopy.label}
              readOnly
              value={manualCopy.url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
        )}
        {!access && !error && <p role="status">Loading sharing settings…</p>}
        {access && (
          <fieldset
            disabled={busy}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            {section === "people" && (
              <div className="share-stack">
                <form
                  className="share-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!sharing.setPerson || !email.trim()) return;
                    void run(async () => {
                      const target = email.trim().toLowerCase();
                      const result = await grant(target, level, pageScope);
                      if (!alive.current) return;
                      if (result?.invited && result.inviteUrl)
                        setInvite({ email: target, url: result.inviteUrl });
                      setEmail("");
                      await changed(async () => {});
                    }, "Couldn't add this person. Your invitation details are still here.");
                  }}
                >
                  <div>
                    <h3>Invite people</h3>
                    <p className="share-subtle">
                      {isPrivate
                        ? "Give people access to this private page only."
                        : withSubpages
                          ? "Give people access to this page and its sub-pages."
                          : "Give people access to this page only."}
                    </p>
                  </div>
                  <div className="share-invite">
                    <input
                      type="email"
                      required
                      aria-label="Invite people"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      autoComplete="email"
                    />
                    {levelSelect(
                      level,
                      setLevel,
                      "Collaborator permission",
                      personChoices,
                    )}
                    <button
                      className="share-primary"
                      disabled={
                        !sharing.setPerson || !email.trim() || !levels.length
                      }
                    >
                      Invite
                    </button>
                  </div>
                  {!isPrivate && (
                    <label className="share-check">
                      <input
                        type="checkbox"
                        checked={withSubpages}
                        onChange={(e) => setWithSubpages(e.target.checked)}
                      />
                      Include sub-pages
                    </label>
                  )}
                  <p>
                    {level === "full"
                      ? "Full access: edit, share with others, move and delete this page."
                      : HELP[level]}{" "}
                    {admin
                      ? "New collaborators receive an account invitation."
                      : "You can share only with existing workspace accounts, within your own permissions."}
                  </p>
                </form>
                {invite && (
                  <div className="share-card share-stack">
                    <h3>Invitation created</h3>
                    <p>
                      This link lets {invite.email} create their account. It
                      expires in seven days.
                    </p>
                    <div className="share-row">
                      {copyButton(invite.url, "invitation")}
                      <button type="button" onClick={() => setInvite(null)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                <section aria-labelledby={`${heading}-people`}>
                  <h3 id={`${heading}-people`}>People with access</h3>
                  {access.owner && (
                    <div className="share-person" data-share-owner>
                      <PersonAvatar name={personName(access.owner)} avatar={access.owner.avatar} seed={access.owner.email ?? access.owner.name} size={32} />
                      <span className="share-who">
                        <strong>{personName(access.owner)}</strong>
                        {access.owner.email && <small>{access.owner.email}</small>}
                      </span>
                      <span className="share-owner">Owner</span>
                    </div>
                  )}
                  {!access.people.length && (
                    <p>
                      Nobody else has been invited to this page directly.
                    </p>
                  )}
                  {access.people.map((person) => (
                    <div className="share-person" key={person.email}>
                      <PersonAvatar name={personName(person)} avatar={person.avatar} seed={person.email} size={32} />
                      <span className="share-who share-email">
                        <strong>{personName(person)}</strong>
                        <small>
                          {[
                            person.name ? person.email : "",
                            person.scope === "page" ? "Includes sub-pages" : person.scope === "note" && !isPrivate ? "This page only" : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                        {person.customPermissions && !isFull(person) && (
                          <small>
                            Custom: {person.caps?.join(", ")}. Selecting a role
                            replaces these permissions.
                          </small>
                        )}
                      </span>
                      {levelSelect<Choice>(
                        isFull(person) ? "full" : person.level,
                        (next) =>
                          void run(
                            () =>
                              changed(() =>
                                grant(person.email, next, person.scope ?? "note"),
                              ),
                            "Couldn't change this person's permission.",
                          ),
                        `Permission for ${person.email}`,
                        personChoices,
                        person.customPermissions && !isFull(person),
                        !sharing.setPerson,
                      )}
                      <button
                        type="button"
                        aria-label={`Remove access for ${person.email}`}
                        title="Remove access"
                        disabled={!sharing.removePerson}
                        onClick={() =>
                          void run(
                            () =>
                              changed(() =>
                                sharing.removePerson!(noteId, person.email),
                              ),
                            "Couldn't remove access.",
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </section>
                {!!access.inherited?.length && (
                  <section aria-labelledby={`${heading}-inherited`}>
                    <h3 id={`${heading}-inherited`}>Inherited access</h3>
                    <p className="share-subtle">
                      These people can open this page because a page above it is shared with them. The nearest shared page decides: setting a permission here replaces what they inherit, for this page and everything inside it — it can restrict as well as expand. Access through tags, links or a workspace role is not affected.
                    </p>
                    {access.inherited.map((person) => (
                      <div className="share-person" key={`inherited-${person.email ?? person.name}-${person.from.id}`} data-inherited-from={person.from.id}>
                        <PersonAvatar name={personName(person)} avatar={person.avatar} seed={person.email ?? person.name} size={32} />
                        <span className="share-who">
                          <strong>{personName(person)}</strong>
                          <small>Inherited from {person.from.title}</small>
                        </span>
                        {person.email ? (
                          levelSelect<Choice>(
                            isFull(person) ? "full" : person.level,
                            (next) =>
                              void run(
                                () => changed(() => grant(person.email!, next, "page")),
                                "Couldn't change this person's permission on this page.",
                              ),
                            `Permission for ${person.email} on this page`,
                            personChoices,
                            false,
                            !sharing.setPerson,
                          )
                        ) : (
                          // Only an administrator changes access that comes from a page above.
                          <span className="share-owner">{isFull(person) ? LABEL.full : LABEL[person.level]}</span>
                        )}
                        <span aria-hidden />
                      </div>
                    ))}
                  </section>
                )}
                <div className="share-card share-stack">
                  <div className="share-row">
                    {isPrivate ? <Lock size={17} /> : <Users size={17} />}
                    <strong style={{ fontSize: 13 }}>
                      {isPrivate ? "Private document" : "Workspace access"}
                    </strong>
                  </div>
                  <p>
                    {isPrivate
                      ? "The creator, explicit document grants and administrators can access this document. Tag and workspace grants do not apply."
                      : "Access can come from document grants, tags, workspace roles or shared links. Removing one grant may leave other access in place."}
                  </p>
                  {admin && sharing.setNoteVisibility && (
                    <button
                      type="button"
                      onClick={() =>
                        void run(
                          () =>
                            changed(() =>
                              sharing.setNoteVisibility!(noteId, !isPrivate),
                            ),
                          "Couldn't change visibility.",
                        )
                      }
                    >
                      {isPrivate ? "Use workspace access" : "Make private"}
                    </button>
                  )}
                </div>
                {!!access.tagAccess.length && (
                  <section>
                    <h3>
                      {isPrivate
                        ? "Tag grants · inactive while private"
                        : "Access through tags"}
                    </h3>
                    {access.tagAccess.map((t, i) => (
                      <p key={`${t.tag}-${i}`}>
                        {t.email ?? t.subjectType} · #{t.tag} ·{" "}
                        {LABEL[t.level] ?? t.level}
                      </p>
                    ))}
                  </section>
                )}
              </div>
            )}
            {section === "links" && admin && (
              <div className="share-stack">
                <div>
                  <h3>Link access</h3>
                  <p>
                    {access.links.some((l) => l.expiresAt > Date.now())
                      ? "Anyone with a link below can open this page without an account, at that link’s permission, until it expires or you revoke it."
                      : "Restricted — only people with access can open this page. Create a link to let anyone who has it open the page without an account."}
                  </p>
                </div>
                <div className="share-row">
                  {levelSelect(linkLevel, setLinkLevel, "Link permission")}
                  <select
                    aria-label="Link expires after"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    {[1, 7, 30, 90].map((d) => (
                      <option key={d} value={d}>
                        {d} {d === 1 ? "day" : "days"}
                      </option>
                    ))}
                  </select>
                </div>
                <p>{HELP[linkLevel]}</p>
                <button
                  type="button"
                  className="share-primary"
                  disabled={!sharing.createLink}
                  onClick={createLinkAndCopy}
                >
                  <Link2 size={16} />
                  Create link
                </button>
                {!access.links.length && (
                  <p>No links have been created for this document.</p>
                )}
                {access.links.map((link) => (
                  <div key={link.id} className="share-card share-stack">
                    <div>
                      <h3>
                        {LABEL[link.level]}
                        {link.label ? ` · ${link.label}` : ""}
                      </h3>
                      <p>
                        {link.expiresAt <= Date.now() ? "Expired" : "Expires"}{" "}
                        {/* "Oct 6", like every other date in the app (the year only when it is not this one). */}
                        {fmtDate(link.expiresAt, new Date(link.expiresAt).getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                    <div className="share-row">
                      {link.expiresAt > Date.now() &&
                        copyButton(link.url, `link ${link.id}`)}
                      <button
                        type="button"
                        disabled={!sharing.revokeLink}
                        onClick={() =>
                          void run(
                            () =>
                              changed(() =>
                                sharing.revokeLink!(noteId, link.id),
                              ),
                            "Couldn't revoke this link. It remains listed until confirmed.",
                          )
                        }
                      >
                        <Trash2 size={16} />
                        Revoke link
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {section === "publish" && admin && (
              <div className="share-stack">
                <div>
                  <h3>Publish a wiki</h3>
                  <p>
                    Publish a collection as a read-only site. This is separate
                    from inviting collaborators or creating document links.
                  </p>
                </div>
                {!access.note.tags.length ? (
                  <p>Add a tag to this document to publish a collection.</p>
                ) : (
                  <>
                    <label>
                      Collection tag
                      <select
                        value={tag}
                        onChange={(e) => {
                          setTag(e.target.value);
                          setPublishedCount(null);
                        }}
                      >
                        {access.note.tags.map((t) => (
                          <option key={t} value={t}>
                            #{t}
                          </option>
                        ))}
                      </select>
                    </label>
                    {/* NP-CO-08: one flow — per-tag explanation, preview, state + address, confirm, password, studio. */}
                    <PublishFlow
                      tag={tag}
                      noteId={noteId}
                      site={publications === null ? undefined : currentPub ?? null}
                      busy={busy}
                      publishedCount={currentPub ? publishedCount : null}
                      copyButton={copyButton}
                      canPublish={!!sharing.publishTag}
                      canUnpublish={!!sharing.unpublishTag}
                      canSetPassword={!!sharing.setPublishPassword}
                      onClose={onClose}
                      onPublish={(pw) =>
                        run(async () => {
                          const result = await sharing.publishTag!(tag, { password: pw });
                          if (!alive.current) return;
                          setPublishedCount(result.count);
                          await loadPublications();
                        }, "Couldn't publish this collection.")
                      }
                      onUnpublish={() =>
                        run(async () => {
                          await sharing.unpublishTag!(tag);
                          if (!alive.current) return;
                          setPublishedCount(null);
                          await loadPublications();
                        }, "Couldn't unpublish this collection.")
                      }
                      onSetPassword={(pw) =>
                        run(async () => {
                          await sharing.setPublishPassword!(tag, pw);
                          await loadPublications();
                        }, "Couldn't update the site password.")
                      }
                    />
                  </>
                )}
              </div>
            )}
            {section === "sync" && admin && (
              <div className="share-stack">
                <div>
                  <h3>Sync with a paired peer</h3>
                  <p>
                    Mirror this document to a connected Parachute peer. Changes
                    can travel between servers according to the permission you
                    choose.
                  </p>
                </div>
                {peers === null ? (
                  <p role="status">
                    {error
                      ? "Peer availability could not be checked."
                      : "Loading paired peers…"}
                  </p>
                ) : !peers.length ? (
                  <p>
                    No paired peers are available. Pair a server in Network
                    settings first.
                  </p>
                ) : (
                  <>
                    <label>
                      Destination peer
                      <select
                        value={peer}
                        onChange={(e) => setPeer(e.target.value)}
                      >
                        {peers.map((p) => (
                          <option key={p.pubkey} value={p.pubkey}>
                            {p.label || p.email || p.fingerprint}
                          </option>
                        ))}
                      </select>
                    </label>
                    {levelSelect(peerLevel, setPeerLevel, "Peer permission")}
                    {peerLevel === "suggest" && <p>{PEER_SUGGEST_HELP}</p>}
                    <button
                      type="button"
                      disabled={!peer}
                      onClick={() =>
                        void run(async () => {
                          await sharing.mirrorNoteToPeer!(
                            noteId,
                            peer,
                            peerLevel,
                          );
                          if (alive.current)
                            setNotice(
                              "Sync started. This document now mirrors to the selected peer.",
                            );
                        }, "Couldn't start peer sync.")
                      }
                    >
                      <Radio size={16} />
                      Start sync
                    </button>
                  </>
                )}
              </div>
            )}
          </fieldset>
        )}
        {busy && <p role="status">Saving changes…</p>}
      </div>
    </dialog>
  );
}
