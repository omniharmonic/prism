import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { AtSign, Bell, CalendarDays, FileText, User } from "lucide-react";
import type { Note } from "../types";
import { noteAliases, noteLinkTitle } from "../wikilinks";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { newMentionUid, type MentionAttrs } from "./MentionNode";
import { parseDateQuery, type DateCandidate } from "./MentionDates";
import { dismissMentionSuggest, type MentionSuggestState } from "./MentionSuggest";
import { mentionNoteId, updateMentionByUid } from "./MentionContext";
import { notificationsApi, localTimeZone } from "../notifications/client";
import { mentionToast } from "./MentionToast";
import { describeEditorPopup } from "./popupAria";
import "./mention.css";

type Item =
  | { kind: "person"; id: string; label: string; detail: string }
  | { kind: "page"; id: string; label: string; detail: string }
  | { kind: "date"; date: DateCandidate }
  | { kind: "remind"; date: DateCandidate };

/** What a row IS (not where it is): rows arrive and move while the person is choosing. */
const itemKey = (it: Item) => (it.kind === "person" || it.kind === "page" ? `${it.kind}:${it.id}` : `${it.kind}:${it.date.date}`);
/** A lookup that never answers must not swallow Enter for good. */
const ENTER_WAIT_MS = 3000;
/** "rem", "remind me friday": the reminder rows only — no people or pages are offered. */
const REMIND = /^rem(?:i(?:n(?:d(?: me)?)?)?)?(?: (.*))?$/;

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
  // Workspace members with no person page (wave 3): mentioned by account.
  const members = useQuery({
    queryKey: ["vault", "people", "mention-members", debounced],
    queryFn: () => notificationsApi.mentionMembers(debounced),
    enabled: state.active,
    staleTime: 30_000,
    retry: false,
  });
  const noteId = mentionNoteId(editor);

  const items = useMemo<Item[]>(() => {
    const q = raw.trim().toLowerCase();
    const remindQuery = q.match(REMIND);
    const out: Item[] = [];
    if (!remindQuery) {
      // People are looked up for the DEBOUNCED query. Until that catches up with what is typed, the
      // answer on hand is for an older query (after "@": everyone): only the people whose name fits
      // the text typed NOW are offered — never a row that Enter would take in place of the date or
      // page the person just typed.
      const inStep = debounced === raw.trim();
      const fits = (name: string) => inStep || !q || name.toLowerCase().includes(q);
      for (const p of (people.data?.people ?? []).filter((x) => fits(x.name)).slice(0, 5)) {
        out.push({ kind: "person", id: p.id, label: p.name, detail: p.role ?? p.identities[0]?.value ?? "Person" });
      }
      for (const m of (members.data ?? []).filter((x) => fits(x.name)).slice(0, Math.max(0, 6 - out.length))) out.push({ kind: "person", id: m.id, label: m.name, detail: "Workspace member" });
      const pages = notes
        .filter((n) => !(n.tags ?? []).includes("person") && n.id !== noteId)
        // A page answers to its title, its file name and its aliases.
        .filter((n) => !q || [noteLinkTitle(n), n.path?.split("/").pop() ?? "", ...noteAliases(n)].some((text) => text.toLowerCase().includes(q)))
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
  }, [raw, debounced, people.data, members.data, notes, noteId]);

  const signature = `${state.from}:${raw}`;
  // The selection is a ROW, not a position: when people arrive above it, a row the person moved
  // to with the arrows stays selected (by index it silently became another row).
  const [sel, setSel] = useState({ signature: "", key: "" });
  const chosen = sel.signature === signature ? items.findIndex((it) => itemKey(it) === sel.key) : -1;
  const index = Math.max(0, chosen);
  // People are still being looked up for the text typed NOW (the debounce has not fired, or its
  // request has not answered). They are listed FIRST, so until then the top row is not the row
  // Enter should take: "@morgan⏎" typed fluently used to insert "Remind me tomorrow" — the only
  // row on screen — and set a reminder. Enter / Tab on the default row waits for the answer.
  const remind = REMIND.test(raw.trim().toLowerCase());
  const lookingUp = state.active && !remind && (debounced !== raw.trim() || (!!client?.listPeople && people.isLoading) || members.isLoading);
  const [wanted, setWanted] = useState<{ signature: string; key: "Enter" | "Tab"; overdue: boolean } | null>(null);
  const waiting = !!wanted && wanted.signature === signature && lookingUp && !wanted.overdue;
  const visible = !!editor && state.active && (items.length > 0 || waiting);

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

  // The press that waited: answered by the list for the text it was pressed on. Typing on, moving
  // the caret or closing the menu makes it void; with nothing to pick the key goes to the editor.
  useEffect(() => {
    if (!wanted) return;
    if (!editor || !state.active || wanted.signature !== signature) { setWanted(null); return; }
    if (lookingUp && !wanted.overdue) {
      const timer = setTimeout(() => setWanted((w) => (w ? { ...w, overdue: true } : w)), ENTER_WAIT_MS);
      return () => clearTimeout(timer);
    }
    setWanted(null);
    if (items[index]) choose(items[index]!);
    else editor.commands.keyboardShortcut(wanted.key);
  }, [wanted, editor, state.active, signature, lookingUp, items, index, choose]);

  useEffect(() => {
    // Listening also while the list is still empty but people are being looked up: Enter there
    // used to fall through to the editor as a line break in the middle of "@name".
    if (!editor || !(visible || lookingUp)) return;
    const el = editor.view.dom;
    const undescribe = visible && items.length ? describeEditorPopup(el, id, `${id}-${index}`) : () => {};
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setSel({ signature, key: itemKey(items[next]!) });
        document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && lookingUp && chosen < 0 && !wanted?.overdue) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDebounced(raw.trim()); // ask now, not after the rest of the debounce
        setWanted({ signature, key: e.key as "Enter" | "Tab", overdue: false });
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && items[index]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(items[index]!);
      } else if (e.key === "Escape" && visible) {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissMentionSuggest(editor, state.from);
        editor.view.dispatch(editor.state.tr); // re-run the trigger → closes
      }
    };
    el.addEventListener("keydown", keydown, true);
    return () => {
      el.removeEventListener("keydown", keydown, true);
      undescribe();
    };
  }, [editor, visible, lookingUp, chosen, wanted, raw, id, index, items, choose, signature, state.from]);

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
                onMouseEnter={() => setSel({ signature, key: itemKey(it) })}
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
      {((people.isFetching && !people.data) || waiting) && (
        <div className="prism-mention-menu-status" role="status"><AtSign size={13} aria-hidden="true" /> Finding people…</div>
      )}
    </div>
  );
}
