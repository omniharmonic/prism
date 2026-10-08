import { useCallback, useEffect, useRef, useState } from "react";
import { useVaultClient } from "../../../../data/VaultClientContext";
import { Button } from "../../../ui/Button";
import { ErrText } from "./shared";
import type {
  CollabSharing,
  PublicationInfo,
} from "../../../../data/CollabSharing";
export function PublicationContent({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const vault = useVaultClient();
  const [notes, setNotes] = useState<Array<{
    id: string;
    title: string;
    path: string | null;
  }> | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(
    new Set(pub.excludeNoteIds ?? []),
  );
  const [home, setHome] = useState<string | null>(pub.homeNoteId ?? null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [privateCount, setPrivateCount] = useState<number | null>(null);
  const [previewExpired, setPreviewExpired] = useState(false);
  const [reload, setReload] = useState(0);

  const noteTitle = useCallback(
    (n: { path: string | null; content?: string }): string => {
      const base = (n.path ?? "").split("/").pop() ?? "";
      return base.replace(/\.[a-z0-9]+$/i, "") || "Untitled";
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    setNotes(null);
    setLoadError("");
    (async () => {
      try {
        if (sharing.previewPublication) {
          const preview = await sharing.previewPublication(pub.slug);
          if (!alive) return;
          setNotes(preview.notes);
          setPrivateCount(preview.privateExcludedCount);
          setPreviewExpired(preview.expired);
          return;
        }
        // Legacy host fallback lists candidates, never an authoritative count.
        // Candidate set: tag pubs → notes with the tag; path pubs → notes under
        // the prefix (filtered client-side, since the vault path filter is exact).
        let list =
          pub.kind === "path"
            ? await vault.listNotes({})
            : await vault.listNotes({ tag: pub.tag });
        if (pub.kind === "path" && pub.pathPrefix) {
          const pre = pub.pathPrefix;
          list = list.filter(
            (n) => n.path === pre || (n.path?.startsWith(pre + "/") ?? false),
          );
        }
        if (!alive) return;
        setNotes(
          list
            .filter((n) => n.metadata?.prism_visibility !== "private")
            .map((n) => ({ id: n.id, title: noteTitle(n), path: n.path }))
            .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "")),
        );
      } catch {
        if (alive)
          setLoadError(
            "The publication preview could not be loaded. Your saved content settings are unchanged.",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    vault,
    sharing,
    pub.slug,
    pub.kind,
    pub.tag,
    pub.pathPrefix,
    noteTitle,
    reload,
  ]);

  const dirty =
    home !== (pub.homeNoteId ?? null) ||
    excluded.size !== (pub.excludeNoteIds?.length ?? 0) ||
    [...excluded].some((id) => !(pub.excludeNoteIds ?? []).includes(id));

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (home === id) setHome(null); // can't home an excluded note
      }
      return next;
    });

  const save = async () => {
    if (
      !sharing.updatePublicationSettings ||
      savingRef.current ||
      !notes ||
      loadError
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await sharing.updatePublicationSettings(pub.slug, {
        homeNoteId: home,
        excludeNoteIds: [...excluded],
      });
      await onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't save content settings.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const includedCount = notes?.filter((n) => !excluded.has(n.id)).length ?? 0;

  return (
    <div
      style={{
        borderTop: "1px dashed var(--glass-border)",
        paddingTop: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          Content
        </div>
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {notes ? `${includedCount} of ${notes.length} selected` : "loading…"}
        </span>
      </div>
      <div
        style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}
      >
        Uncheck a page to exclude it. Choose the page readers land on first.
        Changes apply when you save.
      </div>
      {privateCount !== null && privateCount > 0 && (
        <p className="text-xs text-[var(--text-secondary)]">
          {privateCount} private{" "}
          {privateCount === 1 ? "note stays" : "notes stay"} excluded
          automatically.
        </p>
      )}
      {previewExpired && (
        <p className="text-xs text-[var(--text-secondary)]">
          This publication has expired. Its pages are currently unavailable to
          readers.
        </p>
      )}
      {loadError && (
        <div role="alert" className="text-sm text-[var(--color-error)]">
          {loadError}
          <button
            className="ml-2 min-h-control rounded-lg border border-[var(--glass-border)] px-3"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry preview
          </button>
        </div>
      )}

      <div
        style={{
          maxHeight: 220,
          overflowY: "auto",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          background: "var(--bg-surface, var(--glass))",
        }}
      >
        {!notes ? (
          <div
            style={{
              padding: "12px",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {loadError ? "Preview unavailable" : "Loading pages…"}
          </div>
        ) : notes.length === 0 ? (
          <div
            style={{
              padding: "12px",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            No notes in this collection yet.
          </div>
        ) : (
          notes.map((n) => {
            const isExcluded = excluded.has(n.id);
            return (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  opacity: isExcluded ? 0.5 : 1,
                  borderBottom: "1px solid var(--glass-border)",
                }}
              >
                <label className="grid size-control shrink-0 cursor-pointer place-items-center">
                  <input
                    type="checkbox"
                    aria-label={"Include " + n.title}
                    disabled={saving}
                    checked={!isExcluded}
                    onChange={() => toggle(n.id)}
                    title={
                      isExcluded
                        ? "Include in the wiki"
                        : "Exclude from the wiki"
                    }
                    style={{ width: 18, height: 18, cursor: "pointer" }}
                  />
                </label>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {n.title}
                </span>
                <button
                  type="button"
                  disabled={isExcluded || saving}
                  aria-label={"Set " + n.title + " as home page"}
                  aria-pressed={home === n.id}
                  onClick={() => setHome(home === n.id ? null : n.id)}
                  title="Set as the landing page"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    padding: "2px 7px",
                    borderRadius: 999,
                    cursor: isExcluded ? "default" : "pointer",
                    border: `1px solid ${home === n.id ? "var(--color-accent)" : "var(--glass-border)"}`,
                    background:
                      home === n.id
                        ? "var(--color-accent-dim, var(--glass-hover))"
                        : "transparent",
                    color:
                      home === n.id
                        ? "var(--color-accent)"
                        : "var(--text-muted)",
                  }}
                >
                  {home === n.id ? "Home" : "Set home"}
                </button>
              </div>
            );
          })
        )}
      </div>

      {error && <ErrText>{error}</ErrText>}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="secondary"
          size="sm"
          loading={saving}
          disabled={!dirty || !notes || !!loadError}
          onClick={save}
        >
          Save content
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────── new publication ──
