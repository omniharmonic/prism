import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { AtSign, Bell, CalendarDays, FileText, User } from "lucide-react";
import type { Note } from "../types";
import { noteLinkTitle } from "../wikilinks";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { newMentionUid, type MentionAttrs } from "./MentionNode";
import { parseDateQuery, type DateCandidate } from "./MentionDates";
import { dismissMentionSuggest, type MentionSuggestState } from "./MentionSuggest";
import { mentionNoteId, updateMentionByUid } from "./MentionContext";
import { notificationsApi, localTimeZone } from "../notifications/client";
import { mentionToast } from "./MentionToast";
import "./mention.css";

type Item =
  | { kind: "person"; id: string; label: string; detail: string }
  | { kind: "page"; id: string; label: string; detail: string }
  | { kind: "date"; date: DateCandidate }
  | { kind: "remind"; date: DateCandidate };

/** Insert a chip over the `@query` range, followed by a space. Returns its uid. */
export function insertMention(editor: Editor, range: { from: number; to: number }, attrs: Partial<MentionAttrs>): string {
  const uid = newMentionUid();
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent([
      { type: "mention", attrs: { kind: "page", id: null, label: null, date: null, reminder: null, ...attrs, uid } },
      { type: "text", text: " " },
    ])
    .run();
  return uid;
}

/** Create a reminder for a just-inserted date chip and stamp its id on the chip. */
export async function attachReminder(editor: Editor, uid: string, noteId: string, date: DateCandidate): Promise<void> {
  try {
    const { reminder } = await notificationsApi.createReminder({ noteId, at: date.date, tz: localTimeZone(), dateOnly: date.dateOnly, uid });
    if (!editor.isDestroyed) updateMentionByUid(editor, uid, { reminder: reminder.id });
    mentionToast(`Reminder set for ${date.label}.`);
  } catch {
    mentionToast("The reminder couldn’t be set. Open the date to try again.", true);
  }
}

/**
 * The `@` menu (NP-RF-02): People, Pages, Dates and "Remind me…", one
 * keyboard-accessible listbox (↑/↓, Enter/Tab, Escape) like the `[[` picker.
 * Page items insert the page's ID only — the chip resolves the title through the
 * reader's own permissions.
 */
export function MentionMenu({ editor, state, notes }: { editor: Editor | null; state: MentionSuggestState; notes: Note[] }) {
  const id = useId();
  const client = useOptionalVaultClient();
  const raw = state.query;
  const [debounced, setDebounced] = useState(raw);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 120);
    return () => clearTimeout(t);
  }, [raw]);
  const people = useQuery({
    queryKey: ["vault", "people", "mention-menu", debounced],
    queryFn: () => client!.listPeople!(debounced),
    enabled: !!client?.listPeople && state.active,
    staleTime: 30_000,
    retry: false,
  });
  const noteId = mentionNoteId(editor);

  const items = useMemo<Item[]>(() => {
    const q = raw.trim().toLowerCase();
    const remindQuery = q.match(/^rem(?:i(?:n(?:d(?: me)?)?)?)?(?: (.*))?$/);
    const out: Item[] = [];
    if (!remindQuery) {
      for (const p of (people.data?.people ?? []).slice(0, 5)) {
        out.push({ kind: "person", id: p.id, label: p.name, detail: p.role ?? p.identities[0]?.value ?? "Person" });
      }
      const pages = notes
        .filter((n) => !(n.tags ?? []).includes("person") && n.id !== noteId)
        .filter((n) => !q || noteLinkTitle(n).toLowerCase().includes(q))
        .slice(0, 5);
      for (const n of pages) out.push({ kind: "page", id: n.id, label: noteLinkTitle(n), detail: n.path ?? "" });
    }
    const dates = parseDateQuery(remindQuery ? (remindQuery[1] ?? "") : q);
    if (!remindQuery) for (const d of dates) out.push({ kind: "date", date: d });
    if (noteId) {
      const target = dates[0] ?? parseDateQuery("tomorrow 9am")[0]!;
      out.push({ kind: "remind", date: remindQuery && !dates.length ? parseDateQuery("tomorrow 9am")[0]! : target });
    }
    return out;
  }, [raw, people.data, notes, noteId]);

  const signature = `${state.from}:${raw}`;
  const [sel, setSel] = useState({ signature: "", index: 0 });
  const index = sel.signature === signature ? Math.min(sel.index, Math.max(0, items.length - 1)) : 0;
  const visible = !!editor && state.active && items.length > 0;

  const choose = useCallback(
    (item: Item) => {
      if (!editor) return;
      const range = { from: state.from, to: state.to };
      if (item.kind === "person") insertMention(editor, range, { kind: "person", id: item.id, label: item.label });
      else if (item.kind === "page") insertMention(editor, range, { kind: "page", id: item.id });
      else if (item.kind === "date") insertMention(editor, range, { kind: "date", date: item.date.date });
      else {
        const uid = insertMention(editor, range, { kind: "date", date: item.date.date });
        if (noteId) void attachReminder(editor, uid, noteId, item.date);
      }
    },
    [editor, state.from, state.to, noteId],
  );

  useEffect(() => {
    if (!editor || !visible) return;
    const el = editor.view.dom;
    el.setAttribute("aria-controls", id);
    el.setAttribute("aria-autocomplete", "list");
    el.setAttribute("aria-activedescendant", `${id}-${index}`);
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setSel({ signature, index: next });
        document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && items[index]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(items[index]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissMentionSuggest(editor, state.from);
        editor.view.dispatch(editor.state.tr); // re-run the trigger → closes
      }
    };
    el.addEventListener("keydown", keydown, true);
    return () => {
      el.removeEventListener("keydown", keydown, true);
      for (const n of ["aria-controls", "aria-autocomplete", "aria-activedescendant"]) el.removeAttribute(n);
    };
  }, [editor, visible, id, index, items, choose, signature, state.from]);

  if (!editor || !visible) return null;
  const coords = editor.view.coordsAtPos(Math.min(state.to, editor.state.doc.content.size));
  const width = Math.min(340, window.innerWidth - 16);
  const height = Math.min(360, window.innerHeight - 16);
  const top = coords.bottom + height + 6 > window.innerHeight ? Math.max(8, coords.top - height - 6) : coords.bottom + 6;

  const section = (kind: Item["kind"]) => items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind === kind);
  const groups: Array<{ key: Item["kind"]; label: string }> = [
    { key: "person", label: "People" },
    { key: "page", label: "Pages" },
    { key: "date", label: "Dates" },
    { key: "remind", label: "Reminders" },
  ];
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Mention a person, page or date"
      className="prism-mention-menu glass-elevated"
      style={{ left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)), top, width, maxHeight: height }}
    >
      {groups.map(({ key, label }) => {
        const rows = section(key);
        if (!rows.length) return null;
        return (
          <div key={key} role="group" aria-label={label}>
            <div className="prism-mention-menu-heading" aria-hidden="true">{label}</div>
            {rows.map(({ it, i }) => (
              <button
                key={`${key}-${i}`}
                id={`${id}-${i}`}
                type="button"
                role="option"
                aria-selected={i === index}
                tabIndex={-1}
                className="prism-mention-option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSel({ signature, index: i })}
                onClick={() => choose(it)}
              >
                <span className="prism-mention-option-icon" aria-hidden="true">
                  {it.kind === "person" ? <User size={15} /> : it.kind === "page" ? <FileText size={15} /> : it.kind === "date" ? <CalendarDays size={15} /> : <Bell size={15} />}
                </span>
                <span className="prism-mention-option-copy">
                  <span className="prism-mention-option-label">
                    {it.kind === "person" || it.kind === "page" ? it.label : it.kind === "date" ? it.date.label : `Remind me ${it.date.label}`}
                  </span>
                  {(it.kind === "person" || it.kind === "page") && it.detail && <span className="prism-mention-option-detail">{it.detail}</span>}
                </span>
              </button>
            ))}
          </div>
        );
      })}
      {people.isFetching && !people.data && (
        <div className="prism-mention-menu-status" role="status"><AtSign size={13} aria-hidden="true" /> Finding people…</div>
      )}
    </div>
  );
}
