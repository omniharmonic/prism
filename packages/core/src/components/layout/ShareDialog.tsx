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
} from "../../data/CollabSharing";
import { useAgentChatStore } from "../../lib/agent/chatStore";

type Props = { noteId: string; sharing: CollabSharing; onClose: () => void };
type Section = "people" | "links" | "publish" | "sync";
const LEVELS: ShareLevel[] = ["view", "comment", "suggest", "edit"];
const LABEL: Record<ShareLevel, string> = {
  view: "Can view",
  comment: "Can comment",
  suggest: "Can suggest",
  edit: "Can edit",
};
const HELP: Record<ShareLevel, string> = {
  view: "Read this document without changing it.",
  comment:
    "Read-only in the live editor. Anchored comments currently require Can suggest.",
  suggest: "Propose changes and add anchored comments in the live editor.",
  edit: "Edit this document directly and review suggested changes.",
};
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
  const [level, setLevel] = useState<ShareLevel>("view");
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
  const [password, setPassword] = useState("");
  const [publishedCount, setPublishedCount] = useState<number | null>(null);
  const admin = !!access && access.canManageLinks !== false;
  const levels = access?.allowedLevels ?? LEVELS;
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
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!sharing.getAccess) throw new Error("Sharing is unavailable.");
    const next = await sharing.getAccess(noteId);
    if (!alive.current) return;
    setAccess(next);
    setLevel((current) =>
      (next.allowedLevels ?? LEVELS).includes(current)
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

  async function run(action: () => Promise<void>, fallback: string) {
    if (lock.current || !alive.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(errorText(e, fallback));
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
  async function copy(url: string, label: string) {
    try {
      await navigator.clipboard.writeText(url);
      if (!alive.current) return;
      setCopied(label);
      setManualCopy(null);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        if (alive.current) setCopied("");
      }, 2000);
    } catch {
      if (alive.current) {
        setCopied("");
        setManualCopy({ url, label });
      }
    }
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
  const levelSelect = (
    value: ShareLevel,
    change: (value: ShareLevel) => void,
    label: string,
    options = LEVELS,
    custom = false,
    disabled = false,
  ) => (
    <select
      aria-label={label}
      disabled={disabled}
      value={custom ? "custom" : value}
      onChange={(e) => change(e.target.value as ShareLevel)}
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
      onClick={() => void copy(url, label)}
    >
      {copied === label ? <Check size={16} /> : <Copy size={16} />}{" "}
      {copied === label ? "Copied" : "Copy"}
    </button>
  );
  const tabs: Array<{ id: Section; label: string; icon: ReactNode }> = [
    { id: "people", label: "People", icon: <Users size={16} /> },
    ...(admin
      ? [{ id: "links" as const, label: "Links", icon: <Link2 size={16} /> }]
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
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
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
      .prism-share-dialog button,.prism-share-dialog input,.prism-share-dialog select { min-height:44px; border-radius:8px; border:1px solid var(--glass-border); padding:8px 12px; font:inherit; font-size:13px; background:var(--bg-surface); color:var(--text-primary); max-width:100%; }
      .prism-share-dialog button { display:inline-flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; }
      .prism-share-dialog button:disabled,.prism-share-dialog fieldset:disabled { opacity:.55; }
      .prism-share-dialog :focus-visible { outline:2px solid var(--color-accent); outline-offset:2px; }
      .prism-share-dialog p { margin:0; font-size:13px; line-height:1.6; color:var(--text-secondary); }
      .prism-share-dialog label { display:grid; gap:7px; font-size:12px; color:var(--text-secondary); }
      .prism-share-dialog .share-stack { display:grid; gap:16px; }
      .prism-share-dialog .share-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .prism-share-dialog .share-card { padding:14px; border:1px solid var(--glass-border); border-radius:10px; }
      .prism-share-dialog .share-primary { background:var(--color-accent); color:white; border-color:transparent; }
      .prism-share-dialog h3 { font-size:13px; margin:0 0 8px; font-weight:600; }
      .prism-share-dialog .share-person { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:8px; padding:8px 0; }
      @media(max-width:480px) { .prism-share-dialog .share-person { grid-template-columns:minmax(0,1fr) auto; } .prism-share-dialog .share-person .share-email { grid-column:1/-1; } .prism-share-dialog nav button { flex-direction:column; padding:8px 4px; gap:4px; font-size:12px; } }
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
            Share document
          </h2>
          <p style={{ overflowWrap: "anywhere", marginTop: 4 }}>
            {access?.note.title || "Manage collaboration and access"}
          </p>
        </div>
        <button type="button" aria-label="Close sharing" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <nav
        aria-label="Sharing options"
        className="share-row"
        style={{
          padding: "0 20px 16px",
          borderBottom: "1px solid var(--glass-border)",
          display: "grid",
          gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
          gap: 6,
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={section === t.id ? "page" : undefined}
            disabled={busy}
            onClick={() => choose(t.id)}
            style={
              section === t.id
                ? {
                    background: "var(--surface-hover,var(--glass))",
                    fontWeight: 600,
                  }
                : undefined
            }
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
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
                <form
                  className="share-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!sharing.setPerson || !email.trim()) return;
                    void run(async () => {
                      const target = email.trim().toLowerCase();
                      const result = await sharing.setPerson!(
                        noteId,
                        target,
                        level,
                      );
                      if (!alive.current) return;
                      if (result?.invited && result.inviteUrl)
                        setInvite({ email: target, url: result.inviteUrl });
                      setEmail("");
                      await changed(async () => {});
                    }, "Couldn't add this person. Your invitation details are still here.");
                  }}
                >
                  <label>
                    Add a collaborator
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      autoComplete="email"
                    />
                  </label>
                  <div className="share-row">
                    {levelSelect(
                      level,
                      setLevel,
                      "Collaborator permission",
                      levels,
                    )}
                    <button
                      className="share-primary"
                      disabled={
                        !sharing.setPerson || !email.trim() || !levels.length
                      }
                    >
                      Add person
                    </button>
                  </div>
                  <p>
                    {HELP[level]}{" "}
                    {admin
                      ? "New collaborators receive an account invitation."
                      : "You can share only with existing workspace accounts, within your own permissions."}
                  </p>
                </form>
                {invite && (
                  <div className="share-card share-stack">
                    <h3>Invitation for {invite.email}</h3>
                    <p>
                      This link lets them create their account. Expires in seven
                      days.
                    </p>
                    <div className="share-row">
                      {copyButton(invite.url, "invitation")}
                      <button type="button" onClick={() => setInvite(null)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                <section>
                  <h3>Direct document access</h3>
                  {!access.people.length && (
                    <p>
                      No people have direct grants. Other access paths are
                      listed separately.
                    </p>
                  )}
                  {access.people.map((person) => (
                    <div className="share-person" key={person.email}>
                      <span
                        className="share-email"
                        style={{ fontSize: 13, overflowWrap: "anywhere" }}
                      >
                        {person.email}
                        {person.customPermissions && (
                          <small
                            style={{
                              display: "block",
                              color: "var(--text-secondary)",
                              fontSize: 12,
                            }}
                          >
                            Custom: {person.caps?.join(", ")}. Selecting a role
                            replaces these permissions.
                          </small>
                        )}
                      </span>
                      {levelSelect(
                        person.level,
                        (next) =>
                          void run(
                            () =>
                              changed(() =>
                                sharing.setPerson!(noteId, person.email, next),
                              ),
                            "Couldn't change this person's permission.",
                          ),
                        `Permission for ${person.email}`,
                        levels,
                        person.customPermissions,
                        !sharing.setPerson,
                      )}
                      <button
                        type="button"
                        aria-label={`Remove access for ${person.email}`}
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
                  <h3>Anyone with a link</h3>
                  <p>
                    A link grants access to this document without an account.
                    Each link has its own permission and expiry.
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
                  onClick={() =>
                    void run(async () => {
                      const link = await sharing.createLink!(
                        noteId,
                        linkLevel,
                        days,
                      );
                      if (!alive.current) return;
                      await changed(async () => {});
                      await copy(link.url, `link ${link.id}`);
                    }, "Couldn't create the link.")
                  }
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
                        {new Date(link.expiresAt).toLocaleDateString()}
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
                    <p className="share-card">
                      Publishing includes{" "}
                      {publishedCount === null
                        ? "eligible notes"
                        : `${publishedCount} notes`}{" "}
                      tagged #{tag}, including future notes with this tag.
                      Review the collection before publishing.
                    </p>
                    {publications === null ? (
                      <p role="status">Loading published sites…</p>
                    ) : (
                      <>
                        {currentPub && (
                          <div className="share-card share-stack">
                            <h3>
                              Published
                              {currentPub.passwordRequired
                                ? " · password required"
                                : ""}
                            </h3>
                            {copyButton(currentPub.url, "published site")}
                          </div>
                        )}
                        <label>
                          {currentPub
                            ? "Update site password"
                            : "Site password (optional)"}
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={
                              currentPub?.passwordRequired
                                ? "Enter a new password"
                                : "Leave empty for public access"
                            }
                          />
                        </label>
                        <div className="share-row">
                          {currentPub ? (
                            <>
                              <button
                                type="button"
                                disabled={!sharing.setPublishPassword}
                                onClick={() =>
                                  void run(async () => {
                                    await sharing.setPublishPassword!(
                                      tag,
                                      password || null,
                                    );
                                    if (!alive.current) return;
                                    setPassword("");
                                    await loadPublications();
                                  }, "Couldn't update the site password.")
                                }
                              >
                                {password ? "Set password" : "Remove password"}
                              </button>
                              <button
                                type="button"
                                disabled={!sharing.unpublishTag}
                                onClick={() =>
                                  void run(async () => {
                                    await sharing.unpublishTag!(tag);
                                    await loadPublications();
                                  }, "Couldn't unpublish this collection.")
                                }
                              >
                                Unpublish
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="share-primary"
                              disabled={!sharing.publishTag}
                              onClick={() =>
                                void run(async () => {
                                  const result = await sharing.publishTag!(
                                    tag,
                                    { password: password || undefined },
                                  );
                                  if (!alive.current) return;
                                  setPublishedCount(result.count);
                                  setPassword("");
                                  await loadPublications();
                                }, "Couldn't publish this collection.")
                              }
                            >
                              <Globe size={16} />
                              Publish collection
                            </button>
                          )}
                        </div>
                      </>
                    )}
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
