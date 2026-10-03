import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { User } from "lucide-react";
import { splitCommentMentions, commentMentionToken, isAccountMentionId } from "./MentionParse";
import { notificationsApi } from "../notifications/client";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import type { ContentType } from "../types";
import "./mention.css";

/**
 * Comment mentions (CO-01). Comment text is plain data; a person mention inside
 * it is the token `@[Label](person:<id>)`. `MentionText` renders a comment with
 * those tokens as chips (click → People profile); `useCommentMentionPicker` adds
 * an `@` people picker to any comment textarea/input.
 */
export function MentionText({ text }: { text: string }) {
  const openTab = useUIStore((s) => s.openTab);
  return (
    <>
      {splitCommentMentions(text).map((part, i) =>
        "text" in part ? (
          <span key={i}>{part.text}</span>
        ) : isAccountMentionId(part.id) ? (
          <span key={i} className="prism-comment-mention" data-account="true" aria-label={`Member: ${part.label}`}>@{part.label}</span>
        ) : (
          <span
            key={i}
            role="link"
            tabIndex={0}
            className="prism-comment-mention"
            data-person-id={part.id}
            aria-label={`Person: ${part.label}`}
            onClick={() => openTab(`people:${part.id}`, part.label, "people" as ContentType)}
            onKeyDown={(e) => { if (e.key === "Enter") openTab(`people:${part.id}`, part.label, "people" as ContentType); }}
          >
            @{part.label}
          </span>
        ),
      )}
    </>
  );
}

type Field = HTMLTextAreaElement | HTMLInputElement;

/** The `@query` immediately before the caret, if any (not inside a word/email). */
function activeQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(^|[\s(])@([^\s@[\]()]{0,30})$/);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/**
 * `@` people picker for a comment field. Returns `onKeyDown`/`onSelect` to spread
 * on the field (call `onKeyDown` FIRST; it returns true when it handled the key)
 * and the listbox element to render right after it.
 */
export function useCommentMentionPicker(ref: RefObject<Field | null>, value: string, setValue: (v: string) => void) {
  const client = useOptionalVaultClient();
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const active = activeQuery(value, caret);
  const peopleOpen = !!active && dismissed !== active.start && !!client?.listPeople;
  const people = useQuery({
    queryKey: ["vault", "people", "comment-mention", active?.query ?? ""],
    queryFn: () => client!.listPeople!(active?.query ?? ""),
    enabled: peopleOpen,
    staleTime: 30_000,
    retry: false,
  });
  const members = useQuery({
    queryKey: ["vault", "people", "mention-members", active?.query ?? ""],
    queryFn: () => notificationsApi.mentionMembers(active?.query ?? ""),
    enabled: !!active && dismissed !== active.start,
    staleTime: 30_000,
    retry: false,
  });
  const open = (!!active && dismissed !== active.start) && (!!client?.listPeople || (members.data?.length ?? 0) > 0);
  const items: Array<{ id: string; name: string; role?: string | null }> = open ? [...(people.data?.people ?? []), ...(members.data ?? []).map((m) => ({ ...m, role: "Workspace member" }))].slice(0, 6) : [];
  useEffect(() => setIndex(0), [active?.query]);
  // Place the caret after an inserted token in the same commit as the new value,
  // so typing straight on never lands before it.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (pendingCaret.current === null || !el) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [value, ref]);

  const pick = (person: { id: string; name: string }) => {
    if (!active) return;
    const token = commentMentionToken(person.name, person.id) + " ";
    const next = value.slice(0, active.start) + token + value.slice(caret);
    setValue(next);
    pendingCaret.current = active.start + token.length;
  };

  const sync = () => setCaret(ref.current?.selectionStart ?? value.length);
  return {
    /** True when the key was consumed by the picker. */
    onKeyDown(e: KeyboardEvent<Field>): boolean {
      if (!open || !items.length || e.nativeEvent.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(items[Math.min(index, items.length - 1)]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(active!.start);
        return true;
      }
      return false;
    },
    onSelect: sync,
    onInput: sync,
    fieldProps: open && items.length
      ? { "aria-controls": id, "aria-autocomplete": "list" as const, "aria-activedescendant": `${id}-${Math.min(index, items.length - 1)}` }
      : {},
    menu: open && items.length ? (
      <div id={id} role="listbox" aria-label="Mention a person" className="prism-mention-menu-inline glass-elevated">
        {items.map((p, i) => (
          <button
            key={p.id}
            id={`${id}-${i}`}
            type="button"
            role="option"
            aria-selected={i === index}
            tabIndex={-1}
            className="prism-mention-option"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(p)}
          >
            <span className="prism-mention-option-icon" aria-hidden="true"><User size={14} /></span>
            <span className="prism-mention-option-copy">
              <span className="prism-mention-option-label">{p.name}</span>
              {p.role && <span className="prism-mention-option-detail">{p.role}</span>}
            </span>
          </button>
        ))}
      </div>
    ) : null,
  };
}
