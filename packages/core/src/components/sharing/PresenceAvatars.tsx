import { useEffect, useRef, useState } from "react";
import { revealInToggles } from "../../lib/tiptap/toggleReveal";
import * as Y from "yjs";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import type { Editor } from "@tiptap/react";
import { PersonAvatar } from "./PersonAvatar";

/** Minimal awareness shape (y-protocols Awareness / Hocuspocus provider.awareness). */
export interface PresenceAwareness {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

export interface PresentPerson {
  clientId: number;
  name: string;
  color: string;
  avatar: string | null;
  /** The person has a caret in the document (we can jump to it). */
  hasCaret: boolean;
}

/** People on this page right now (everyone but this tab), from collab awareness. Pure. */
export function presentPeople(awareness: Pick<PresenceAwareness, "clientID" | "getStates">): PresentPerson[] {
  const out: PresentPerson[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = state.user as { name?: unknown; color?: unknown; avatar?: unknown } | undefined;
    if (!user || typeof user.name !== "string" || !user.name.trim()) return;
    out.push({
      clientId,
      name: user.name.trim().slice(0, 80),
      color: typeof user.color === "string" && /^#[0-9a-f]{3,8}$/i.test(user.color) ? user.color : "#64748b",
      avatar: typeof user.avatar === "string" && user.avatar.startsWith("data:image/") ? user.avatar : null,
      hasCaret: !!(state.cursor && typeof state.cursor === "object"),
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.clientId - b.clientId);
}

/** The document position of a collaborator's caret, or null when it can't be placed. */
export function caretPosition(editor: Editor, awareness: PresenceAwareness, clientId: number): number | null {
  const state = awareness.getStates().get(clientId);
  const cursor = state?.cursor as { head?: unknown } | undefined;
  const sync = ySyncPluginKey.getState(editor.state) as { doc: Y.Doc; type: Y.XmlFragment; binding?: { mapping: Map<unknown, unknown> } } | undefined;
  if (!cursor?.head || !sync?.binding) return null;
  try {
    const pos = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(cursor.head), sync.binding.mapping as never);
    if (pos === null || pos === undefined) return null;
    return Math.max(0, Math.min(pos, editor.state.doc.content.size));
  } catch {
    return null;
  }
}

/** Scroll the page to a collaborator's caret and flash it. Returns false when they have none. */
export function jumpToCaret(editor: Editor, awareness: PresenceAwareness, person: PresentPerson): boolean {
  const pos = caretPosition(editor, awareness, person.clientId);
  if (pos === null) return false;
  const view = editor.view;
  let target: Element | null = null;
  try {
    const at = view.domAtPos(pos);
    target = at.node instanceof Element ? at.node : at.node.parentElement;
  } catch {
    target = null;
  }
  revealInToggles(target);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  // Flash the caret widget(s) drawn for this person (name label matches).
  for (const caret of view.dom.querySelectorAll<HTMLElement>(".collaboration-carets__caret")) {
    if (caret.textContent?.trim() !== person.name) continue;
    caret.setAttribute("data-prism-flash", "true");
    window.setTimeout(() => caret.removeAttribute("data-prism-flash"), 1600);
  }
  return true;
}

/**
 * Header presence (NP-CO-11): avatars of the people on this page, standalone so
 * any header can mount it. Click an avatar to jump to that person's caret. On a
 * phone (`compact`) it collapses to one count chip that opens the same list.
 *
 * Mount in the document chrome with the live provider's awareness and the editor:
 *   <PresenceAvatars awareness={provider.awareness} editor={editor} />
 */
export function PresenceAvatars({
  awareness,
  editor,
  compact = false,
  max = 4,
}: {
  awareness: PresenceAwareness | null | undefined;
  editor?: Editor | null;
  compact?: boolean;
  max?: number;
}) {
  const [people, setPeople] = useState<PresentPerson[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!awareness) return setPeople([]);
    const update = () => setPeople(presentPeople(awareness));
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
  }, [awareness]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!awareness || !people.length) return null;

  const jump = (p: PresentPerson) => {
    setOpen(false);
    if (!editor || editor.isDestroyed || !jumpToCaret(editor, awareness, p)) setNotice(`${p.name} isn’t in the text right now.`);
    else setNotice(`Jumped to ${p.name}.`);
    window.setTimeout(() => setNotice(""), 2500);
  };
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const label = `${people.length} ${people.length === 1 ? "person" : "people"} on this page`;

  return (
    <div ref={root} className="prism-presence" role="group" aria-label={label}>
      <style>{`
        .prism-presence { position: relative; display: inline-flex; align-items: center; }
        .prism-presence .prism-presence-stack { display: inline-flex; align-items: center; }
        .prism-presence button.prism-presence-person { padding: 0; border: 2px solid var(--bg-base, var(--bg-surface)); border-radius: 999px; background: none; cursor: pointer; line-height: 0; transition: transform 120ms ease; }
        .prism-presence button.prism-presence-person + button.prism-presence-person { margin-left: -7px; }
        .prism-presence button.prism-presence-person:hover { transform: translateY(-1px); z-index: 1; }
        .prism-presence button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; z-index: 2; }
        .prism-presence .prism-presence-count { min-width: 30px; height: 30px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--glass-border); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
        .prism-presence .prism-presence-list { position: absolute; right: 0; top: calc(100% + 6px); z-index: 70; min-width: 220px; max-width: min(300px, calc(100vw - 32px)); padding: 6px; border-radius: 12px; border: 1px solid var(--glass-border); background: var(--bg-surface); box-shadow: 0 12px 32px rgb(0 0 0 / .18); }
        .prism-presence .prism-presence-list button { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 8px; border: 0; border-radius: 8px; background: none; color: var(--text-primary); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
        .prism-presence .prism-presence-list button:hover { background: var(--glass-hover, var(--surface-hover)); }
        .prism-presence .prism-presence-list small { color: var(--text-muted); font-size: 11.5px; }
        .prism-presence .prism-presence-notice { position: absolute; right: 0; top: calc(100% + 6px); white-space: nowrap; font-size: 11.5px; color: var(--text-muted); }
        .collaboration-carets__caret[data-prism-flash] { animation: prism-caret-flash 1.4s ease; }
        @keyframes prism-caret-flash { 0%, 60% { box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 0%, transparent), 0 0 0 6px rgb(59 130 246 / .35); } 100% { box-shadow: none; } }
        @media (prefers-reduced-motion: reduce) { .prism-presence button.prism-presence-person { transition: none; } .collaboration-carets__caret[data-prism-flash] { animation: none; outline: 2px solid var(--color-accent); } }
      `}</style>
      {compact ? (
        <button type="button" className="prism-presence-count" aria-expanded={open} aria-label={`${label}. Show who`} onClick={() => setOpen((o) => !o)}>
          <span style={{ display: "inline-flex" }}>
            <PersonAvatar name={people[0]!.name} avatar={people[0]!.avatar} color={people[0]!.color} size={20} />
          </span>
          {people.length}
        </button>
      ) : (
        <div className="prism-presence-stack">
          {shown.map((p) => (
            <button key={p.clientId} type="button" className="prism-presence-person" title={`${p.name} — jump to their cursor`} aria-label={`${p.name}: jump to their cursor`} onClick={() => jump(p)}>
              <PersonAvatar name={p.name} avatar={p.avatar} color={p.color} size={28} />
            </button>
          ))}
          {extra > 0 && (
            <button type="button" className="prism-presence-count" style={{ marginLeft: 4 }} aria-expanded={open} aria-label={`${extra} more on this page`} onClick={() => setOpen((o) => !o)}>
              +{extra}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="prism-presence-list" role="list" aria-label="On this page">
          {people.map((p) => (
            <div role="listitem" key={p.clientId}>
              <button type="button" onClick={() => jump(p)}>
                <PersonAvatar name={p.name} avatar={p.avatar} color={p.color} size={26} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <small>{p.hasCaret ? "Jump to cursor" : "Reading"}</small>
              </button>
            </div>
          ))}
        </div>
      )}
      {notice && !open && (
        <span role="status" className="prism-presence-notice">
          {notice}
        </span>
      )}
    </div>
  );
}
