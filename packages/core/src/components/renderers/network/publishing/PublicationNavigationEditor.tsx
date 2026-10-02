import { useEffect, useState } from "react";
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
  const [notes, setNotes] = useState<PublicationPreview["notes"] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setNotes(null);
    setError("");
    sharing
      .previewPublication?.(slug)
      .then((preview) => {
        if (alive) setNotes(preview.notes.filter((n) => !n.excluded));
      })
      .catch((e) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Could not load eligible pages.",
          );
      });
    return () => {
      alive = false;
    };
  }, [sharing, slug, retry]);
  const navigation = parsePublicationNavigation(value, true);
  const sections = navigation?.sections ?? [];
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
    <section
      className="space-y-3 rounded-lg border border-[var(--glass-border)] p-3"
      aria-label="Site navigation"
    >
      <div>
        <h4 className="text-sm font-medium">Site navigation</h4>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Arrange pages into sections. Unassigned and newly eligible pages
          remain available under More pages. This does not change page
          visibility.
        </p>
      </div>
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
      {!navigation && (
        <p className="text-xs text-[var(--text-secondary)]">
          Using the page path tree.
        </p>
      )}
      {sections.map((section, i) => (
        <div
          key={i}
          className="space-y-2 rounded-lg border border-[var(--glass-border)] p-3"
          role="group"
          aria-label={`Navigation section ${i + 1}`}
        >
          <Input
            aria-label={`Section ${i + 1} title`}
            maxLength={80}
            value={section.title}
            onChange={(e) => sectionUpdate(i, { title: e.target.value })}
          />
          <div className="flex flex-wrap gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={i === 0}
              aria-label={`Move section ${i + 1} up`}
              onClick={() => update(move(sections, i, i - 1))}
            >
              Move up
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={i === sections.length - 1}
              aria-label={`Move section ${i + 1} down`}
              onClick={() => update(move(sections, i, i + 1))}
            >
              Move down
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove section ${i + 1}`}
              onClick={() => update(sections.filter((_, n) => n !== i))}
            >
              Remove section
            </Button>
          </div>
          <ol className="space-y-1">
            {section.noteIds.map((id, j) => (
              <li
                key={id}
                className="flex flex-wrap items-center gap-1 text-xs"
              >
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
                  ↑
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
                  ↓
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
                  Remove
                </Button>
              </li>
            ))}
          </ol>
          <select
            aria-label={`Add page to section ${i + 1}`}
            value=""
            disabled={!notes || assigned.size >= 64}
            className="min-h-11 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
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
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={sections.length >= 8}
          onClick={() =>
            update([
              ...sections,
              { title: `Section ${sections.length + 1}`, noteIds: [] },
            ])
          }
        >
          Add navigation section
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
