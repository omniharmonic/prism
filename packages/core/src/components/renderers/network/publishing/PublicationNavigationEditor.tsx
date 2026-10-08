import { useEffect, useRef, useState } from "react";
import { useVaultClient } from "../../../../data/VaultClientContext";
import { useVaultChangeSignal } from "../../../../data/CollabSharing";
import {
  ArrowUp,
  ArrowDown,
  Plus,
  X,
  ListTree,
  ChevronDown,
} from "lucide-react";
import type {
  CollabSharing,
  PublicationPreview,
} from "../../../../data/CollabSharing";
import {
  parsePublicationNavigation,
  type PublicationNavigation,
} from "../../../../lib/publishing/navigation";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { ErrText } from "./shared";

/** Candidate labels come only from the authorized membership preview. Saved
 * unavailable IDs remain editable/removable but never reveal their old titles. */
export function PublicationNavigationEditor({
  slug,
  sharing,
  value,
  onChange,
}: {
  slug: string;
  sharing: CollabSharing;
  value: PublicationNavigation | undefined;
  onChange: (value: PublicationNavigation | undefined) => void;
}) {
  const client = useVaultClient();
  const signal = useVaultChangeSignal();
  const scope = client.scope?.() ?? null;
  const [result, setResult] = useState<{
    scope: string | null;
    notes: PublicationPreview["notes"];
  } | null>(null);
  const notes = result?.scope === scope ? result.notes : null;
  const keys = useRef<string[]>([]);
  const sequence = useRef(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setResult(null);
    setError("");
    sharing
      .previewPublication?.(slug)
      .then((preview) => {
        if (alive && (client.scope?.() ?? null) === scope)
          setResult({ scope, notes: preview.notes.filter((n) => !n.excluded) });
      })
      .catch((e) => {
        if (alive && (client.scope?.() ?? null) === scope)
          setError(
            e instanceof Error ? e.message : "Could not load eligible pages.",
          );
      });
    return () => {
      alive = false;
    };
  }, [sharing, slug, retry, client, scope, signal]);
  const navigation = parsePublicationNavigation(value, true);
  const sections = navigation?.sections ?? [];
  while (keys.current.length < sections.length)
    keys.current.push(`section-${++sequence.current}`);
  keys.current.length = sections.length;
  const unsupported = !!value && !navigation;
  const assigned = new Set(sections.flatMap((section) => section.noteIds));
  const labels = new Map(notes?.map((n) => [n.id, n.title]));
  const update = (next: PublicationNavigation["sections"]) =>
    onChange({ version: 1, sections: next });
  const sectionUpdate = (
    index: number,
    patch: Partial<PublicationNavigation["sections"][number]>,
  ) => update(sections.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  function move<T>(items: T[], from: number, to: number): T[] {
    const next = [...items];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  }
  return (
    <section className="prism-site-navigation" aria-label="Site navigation">
      <div>
        <h4>
          <ListTree size={15} aria-hidden="true" /> Site navigation
        </h4>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Arrange pages into sections. Unassigned and newly eligible pages
          remain available under More pages. This does not change page
          visibility.
        </p>
      </div>
      <p className="prism-site-navigation-count">
        {sections.length}/8 sections · {assigned.size}/64 pages arranged
      </p>
      {unsupported && (
        <ErrText>
          This saved navigation format is not supported. Keep it unchanged or
          explicitly return to the page path tree.
        </ErrText>
      )}
      {error && <ErrText>{error}</ErrText>}
      {error && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRetry((n) => n + 1)}
        >
          Retry eligible pages
        </Button>
      )}
      {!notes && !error && (
        <p role="status" className="text-xs">
          Loading eligible pages…
        </p>
      )}
      {!value && (
        <p className="text-xs text-[var(--text-secondary)]">
          Using the page path tree.
        </p>
      )}
      {sections.map((section, i) => (
        <div
          key={keys.current[i]}
          className="prism-site-navigation-section"
          role="group"
          aria-label={`Navigation section ${i + 1}`}
        >
          <Input
            aria-label={`Section ${i + 1} title`}
            maxLength={80}
            value={section.title}
            onChange={(e) => sectionUpdate(i, { title: e.target.value })}
            placeholder="Section name"
            aria-invalid={!section.title.trim()}
          />
          {!section.title.trim() && (
            <p className="text-xs text-[var(--text-secondary)]">
              Name this section before saving.
            </p>
          )}
          <div className="prism-site-navigation-tools">
            <Button
              variant="ghost"
              size="sm"
              disabled={i === 0}
              aria-label={`Move section ${i + 1} up`}
              onClick={() => {
                keys.current = move(keys.current, i, i - 1);
                update(move(sections, i, i - 1));
              }}
            >
              <ArrowUp size={13} aria-hidden="true" /> Earlier
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={i === sections.length - 1}
              aria-label={`Move section ${i + 1} down`}
              onClick={() => {
                keys.current = move(keys.current, i, i + 1);
                update(move(sections, i, i + 1));
              }}
            >
              <ArrowDown size={13} aria-hidden="true" /> Later
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove section ${i + 1}`}
              onClick={() => {
                keys.current.splice(i, 1);
                update(sections.filter((_, n) => n !== i));
              }}
            >
              <X size={13} aria-hidden="true" /> Remove
            </Button>
          </div>
          <ol className="space-y-1">
            {section.noteIds.map((id, j) => (
              <li key={id} className="prism-site-navigation-page">
                <span className="min-w-0 flex-1 break-words">
                  {labels.get(id) ??
                    (notes ? "Unavailable page" : "Loading page…")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={j === 0}
                  aria-label={`Move page ${j + 1} up in section ${i + 1}`}
                  onClick={() =>
                    sectionUpdate(i, {
                      noteIds: move(section.noteIds, j, j - 1),
                    })
                  }
                >
                  <ArrowUp size={13} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={j === section.noteIds.length - 1}
                  aria-label={`Move page ${j + 1} down in section ${i + 1}`}
                  onClick={() =>
                    sectionUpdate(i, {
                      noteIds: move(section.noteIds, j, j + 1),
                    })
                  }
                >
                  <ArrowDown size={13} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove page ${j + 1} from section ${i + 1}`}
                  onClick={() =>
                    sectionUpdate(i, {
                      noteIds: section.noteIds.filter((n) => n !== id),
                    })
                  }
                >
                  <X size={13} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ol>
          <div className="prism-site-navigation-picker">
            <select
              aria-label={`Add page to section ${i + 1}`}
              value=""
              disabled={
                !notes ||
                assigned.size >= 64 ||
                notes.every((n) => assigned.has(n.id))
              }
              className="min-h-control w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
              onChange={(e) => {
                if (e.target.value)
                  sectionUpdate(i, {
                    noteIds: [...section.noteIds, e.target.value],
                  });
              }}
            >
              <option value="">Add an eligible page…</option>
              {notes
                ?.filter((n) => !assigned.has(n.id))
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={sections.length >= 8 || unsupported}
          onClick={() =>
            update([
              ...sections,
              { title: `Section ${sections.length + 1}`, noteIds: [] },
            ])
          }
        >
          <Plus size={14} aria-hidden="true" /> Add navigation section
        </Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            Use page path tree
          </Button>
        )}
      </div>
    </section>
  );
}
