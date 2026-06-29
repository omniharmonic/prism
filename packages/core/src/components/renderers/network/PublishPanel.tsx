// PublishPanel — the Publishing management surface (Network → Publish).
//
// The in-app, no-CLI surface where the owner turns a tag into a public,
// read-only Wiki and manages what's exposed. Two halves:
//   1. A live, auditable list of current publications (each reversible).
//   2. A "Publish a collection" affordance: pick a tag → publish → get a URL.
//
// Everything network goes through the `useCollabSharing()` seam; vault data
// (tags + live note counts) through `useVaultClient()`. No apps/web imports.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Globe,
  Copy,
  Check,
  Trash2,
  Lock,
  Plus,
  ExternalLink,
  Settings2,
  Hash,
  FolderTree,
  X,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import { useCollabSharing, type PublicationInfo } from "../../../data/CollabSharing";
import { useVaultClient } from "../../../data/VaultClientContext";
import type { TagCount } from "../../../lib/types";
import { TagPicker } from "./TagPicker";

/** Human label for a publication's slice: `#tag` or the path prefix. */
function pubSlice(pub: PublicationInfo): string {
  return pub.kind === "path" ? pub.pathPrefix ?? "" : `#${pub.tag}`;
}

export function PublishPanel() {
  const sharing = useCollabSharing();
  const vault = useVaultClient();

  const [pubs, setPubs] = useState<PublicationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live note counts per tag (so "N notes" stays honest as the vault grows).
  const [counts, setCounts] = useState<Record<string, number>>({});
  // All vault tags, for the picker.
  const [tags, setTags] = useState<TagCount[]>([]);

  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!sharing?.listPublications) return;
    setError(null);
    try {
      const list = await sharing.listPublications();
      setPubs(list);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load publications.");
      return [] as PublicationInfo[];
    }
  }, [sharing]);

  // Initial load: publications + the tag list (for the picker).
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [list] = await Promise.all([
        refresh(),
        vault
          .getTags()
          .then((t) => alive && setTags(t))
          .catch(() => {}),
      ]);
      if (!alive) return;
      // Seed live counts for whatever is already published.
      if (list) void loadCounts(list);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Live note counts per publication (keyed by slug). Tag pubs count by tag;
  // PATH pubs count membership under the prefix — NOT listNotes({tag:""}), which
  // returns the WHOLE vault (the "Publishing 8465 notes" miscount). The number
  // here matches what's actually published.
  const loadCounts = useCallback(
    async (pubList: PublicationInfo[]) => {
      await Promise.all(
        pubList
          .filter((p) => p.kind !== "path")
          .map(async (p) => {
            try {
              const notes = await vault.listNotes({ tag: p.tag });
              setCounts((c) => ({ ...c, [p.slug]: notes.length }));
            } catch {
              /* leave undefined → falls back to picker count */
            }
          }),
      );
      const pathPubs = pubList.filter((p) => p.kind === "path");
      if (pathPubs.length) {
        try {
          const all = await vault.listNotes({}); // one fetch, filtered per prefix
          setCounts((c) => {
            const next = { ...c };
            for (const p of pathPubs) {
              const pre = p.pathPrefix ?? "";
              next[p.slug] = all.filter(
                (n) => n.path === pre || (n.path?.startsWith(pre + "/") ?? false),
              ).length;
            }
            return next;
          });
        } catch {
          /* leave undefined */
        }
      }
    },
    [vault],
  );

  const copy = useCallback((text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1600);
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  // Resolve the best-known count for a publication: live count (by slug) > picker
  // count (tag pubs only — a path pub's count is meaningless against the tag list).
  const countFor = useCallback(
    (pub: PublicationInfo): number | undefined => {
      if (counts[pub.slug] !== undefined) return counts[pub.slug];
      return pub.kind === "tag" ? tags.find((t) => t.tag === pub.tag)?.count : undefined;
    },
    [counts, tags],
  );

  const publishedTags = useMemo(
    () => new Set(pubs.filter((p) => p.kind !== "path").map((p) => p.tag)),
    [pubs],
  );

  // Guard: parent only renders us when publishTag exists, but be defensive.
  // (All hooks run above this point — no early-return-before-hooks.)
  if (!sharing?.publishTag || !sharing.listPublications) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Publishing isn't available on this shell.
      </div>
    );
  }

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--text-muted)",
          fontSize: 13,
          padding: "32px 0",
        }}
      >
        <Spinner /> Loading publications…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--color-danger, #EB5757)",
            background: "color-mix(in srgb, var(--color-danger, #EB5757) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-danger, #EB5757) 30%, transparent)",
            borderRadius: "var(--radius-md, 10px)",
            padding: "10px 12px",
          }}
        >
          {error}
        </div>
      )}

      {/* ── Live publications: the "what's currently exposed" audit view ── */}
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionLabel>Published collections</SectionLabel>

        {pubs.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {pubs.map((p) => (
              <PublicationRow
                key={p.slug}
                pub={p}
                count={countFor(p)}
                copied={copied}
                onCopy={copy}
                sharing={sharing}
                onChanged={async () => {
                  const list = await refresh();
                  if (list) void loadCounts(list);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── New publication ── */}
      <NewPublication
        tags={tags}
        publishedTags={publishedTags}
        sharing={sharing}
        onPublished={async () => {
          const list = await refresh();
          // Live counts only apply to tag pubs (path pubs report their own count).
          if (list) void loadCounts(list);
        }}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── empty state ──

function EmptyState() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        textAlign: "center",
        padding: "36px 20px",
        background: "var(--glass)",
        border: "1px dashed var(--glass-border)",
        borderRadius: "var(--radius-lg, 14px)",
        color: "var(--text-muted)",
      }}
    >
      <Globe size={22} style={{ opacity: 0.6 }} />
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
        Nothing published yet.
      </div>
      <div style={{ fontSize: 12.5, maxWidth: 360 }}>
        Pick a tag below to turn that collection into a public, read-only Wiki. Future notes with the
        same tag are included automatically.
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────── publication row ──

function PublicationRow({
  pub,
  count,
  copied,
  onCopy,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  count: number | undefined;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  sharing: NonNullable<ReturnType<typeof useCollabSharing>>;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const unpublish = async () => {
    // Prefer the slug-based unpublish (works for tag + path); fall back to tag.
    if (!sharing.unpublish && !sharing.unpublishTag) return;
    setBusy(true);
    try {
      if (sharing.unpublish) await sharing.unpublish(pub.slug);
      else await sharing.unpublishTag!(pub.tag);
      await onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const copyKey = `pub-${pub.slug}`;
  const slice = pubSlice(pub);
  const title = pub.title?.trim() || slice;

  return (
    <div
      data-pub-slug={pub.slug}
      style={{
        background: "var(--glass)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-lg, 14px)",
        overflow: "hidden",
      }}
    >
      {/* Header row: identity, badges, primary actions. */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: 14,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-accent)",
            color: "white",
          }}
        >
          <Globe size={17} />
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>
              {title}
            </span>
            {pub.passwordRequired ? (
              <Badge variant="warning">
                <Lock size={11} /> Password
              </Badge>
            ) : (
              <Badge variant="success">Public</Badge>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
            <span style={{ color: "var(--text-secondary)" }}>{slice}</span>
            {" · "}
            {count !== undefined ? `${count} ${count === 1 ? "note" : "notes"}` : "live"}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a href={pub.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <Button variant="secondary" size="sm" icon={<ExternalLink size={13} />}>
              Open
            </Button>
          </a>
          <Button
            variant="ghost"
            size="sm"
            icon={<Settings2 size={14} />}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            Settings
          </Button>
        </div>
      </div>

      {/* URL + copy. */}
      <div style={{ padding: "0 14px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <input
          readOnly
          value={pub.url}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            padding: "7px 10px",
            borderRadius: 8,
            outline: "none",
            background: "var(--bg-surface, var(--glass))",
            border: "1px solid var(--glass-border)",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={copied === copyKey ? <Check size={13} /> : <Copy size={13} />}
          onClick={() => onCopy(pub.url, copyKey)}
        >
          {copied === copyKey ? "Copied" : "Copy"}
        </Button>
      </div>

      {/* Dynamic-count honesty line (principle 8). */}
      <div
        style={{
          padding: "0 14px 12px",
          fontSize: 11.5,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        Publishing {count !== undefined ? <strong>{count}</strong> : "all"}{" "}
        {count === 1 ? "note" : "notes"} — dynamic: future notes{" "}
        {pub.kind === "path" ? "under" : "tagged"}{" "}
        <span style={{ color: "var(--text-secondary)" }}>{slice}</span> are included too.
      </div>

      {/* Expandable per-publication settings. */}
      {open && (
        <PublicationSettings pub={pub} sharing={sharing} onChanged={onChanged} />
      )}

      {/* Unpublish (with confirm). */}
      <div
        style={{
          borderTop: "1px solid var(--glass-border)",
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        {confirming ? (
          <>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", marginRight: "auto" }}>
              Unpublish {slice}? The public link stops working immediately.
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              icon={<Trash2 size={13} />}
              onClick={unpublish}
              style={{ background: "var(--color-danger, #EB5757)", color: "white" }}
            >
              Unpublish
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={() => setConfirming(true)}
            style={{ color: "var(--color-danger, #EB5757)" }}
          >
            Unpublish
          </Button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────── publication settings ──

function PublicationSettings({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: NonNullable<ReturnType<typeof useCollabSharing>>;
  onChanged: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState(pub.title ?? "");
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const titleDirty = (title.trim() || null) !== (pub.title?.trim() || null);

  const saveTitle = async () => {
    if (!titleDirty) return;
    setSavingTitle(true);
    setTitleError(null);
    try {
      // Title is a per-publication SETTING — update it by slug. (Re-publishing an
      // existing tag/path only updated the password, so the title never stuck.)
      if (sharing.updatePublicationSettings) {
        await sharing.updatePublicationSettings(pub.slug, { title: title.trim() || null });
      } else {
        const opts = { template: pub.template || "wiki", title: title.trim() };
        if (pub.kind === "path") await sharing.publishPath?.(pub.pathPrefix ?? "", opts);
        else await sharing.publishTag?.(pub.tag, opts);
      }
      await onChanged();
    } catch (e) {
      setTitleError(e instanceof Error ? e.message : "Couldn't save the title.");
    } finally {
      setSavingTitle(false);
    }
  };

  const setPw = async (value: string | null) => {
    setSavingPw(true);
    setPwError(null);
    try {
      // Prefer the slug-based setter (tag + path); fall back to the tag setter.
      if (sharing.setPublicationPassword) await sharing.setPublicationPassword(pub.slug, value);
      else await sharing.setPublishPassword?.(pub.tag, value);
      setPassword("");
      await onChanged();
    } catch (e) {
      setPwError(e instanceof Error ? e.message : "Couldn't update the password.");
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--glass-border)",
        background: "var(--glass-hover)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Title */}
      <Field label="Title" hint="Shown as the Wiki's heading. Defaults to the tag name.">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Input
              value={title}
              placeholder={`#${pub.tag}`}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTitle();
              }}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={savingTitle}
            disabled={!titleDirty}
            onClick={saveTitle}
          >
            Save
          </Button>
        </div>
        {titleError && <ErrText>{titleError}</ErrText>}
      </Field>

      {/* Password */}
      <Field
        label="Password"
        hint={
          pub.passwordRequired
            ? "This Wiki requires a password. Clear it to make it fully public."
            : "Optional. Add a password to gate the public link."
        }
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Input
              type="password"
              value={password}
              placeholder={pub.passwordRequired ? "Set a new password" : "Add a password"}
              icon={<Lock size={13} />}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password) void setPw(password);
              }}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={savingPw && password !== ""}
            disabled={!password}
            onClick={() => setPw(password)}
          >
            {pub.passwordRequired ? "Change" : "Set"}
          </Button>
          {pub.passwordRequired && (
            <Button
              variant="ghost"
              size="sm"
              loading={savingPw && password === ""}
              onClick={() => setPw(null)}
            >
              Make public
            </Button>
          )}
        </div>
        {pwError && <ErrText>{pwError}</ErrText>}
      </Field>

      {/* Per-publication content tending: home note + hand-exclude notes. */}
      {sharing.updatePublicationSettings && (
        <PublicationContent pub={pub} sharing={sharing} onChanged={onChanged} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────── publication content ──
// Lets the owner pick the landing note and exclude individual notes from the
// public set when the tag/path heuristic sweeps in something that shouldn't be
// public (or renders messily). Owner-only; uses the full vault to enumerate the
// candidate set (including currently-excluded notes, so they can be re-included).

function PublicationContent({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: NonNullable<ReturnType<typeof useCollabSharing>>;
  onChanged: () => void | Promise<void>;
}) {
  const vault = useVaultClient();
  const [notes, setNotes] = useState<Array<{ id: string; title: string; path: string | null }> | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set(pub.excludeNoteIds ?? []));
  const [home, setHome] = useState<string | null>(pub.homeNoteId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteTitle = useCallback((n: { path: string | null; content?: string }): string => {
    const base = (n.path ?? "").split("/").pop() ?? "";
    return base.replace(/\.[a-z0-9]+$/i, "") || "Untitled";
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Candidate set: tag pubs → notes with the tag; path pubs → notes under
        // the prefix (filtered client-side, since the vault path filter is exact).
        let list = pub.kind === "path" ? await vault.listNotes({}) : await vault.listNotes({ tag: pub.tag });
        if (pub.kind === "path" && pub.pathPrefix) {
          const pre = pub.pathPrefix;
          list = list.filter((n) => n.path === pre || (n.path?.startsWith(pre + "/") ?? false));
        }
        if (!alive) return;
        setNotes(
          list
            .map((n) => ({ id: n.id, title: noteTitle(n), path: n.path }))
            .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "")),
        );
      } catch {
        if (alive) setNotes([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, pub.kind, pub.tag, pub.pathPrefix, noteTitle]);

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
    if (!sharing.updatePublicationSettings) return;
    setSaving(true);
    setError(null);
    try {
      await sharing.updatePublicationSettings(pub.slug, {
        homeNoteId: home,
        excludeNoteIds: [...excluded],
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save content settings.");
    } finally {
      setSaving(false);
    }
  };

  const includedCount = (notes?.length ?? 0) - excluded.size;

  return (
    <div style={{ borderTop: "1px dashed var(--glass-border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-secondary)" }}>Content</div>
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {notes ? `${includedCount} of ${notes.length} public` : "loading…"}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
        Uncheck a note to keep it out of the public wiki. Pick one as the landing page.
      </div>

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
          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>Loading notes…</div>
        ) : notes.length === 0 ? (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>No notes in this collection yet.</div>
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
                <input
                  type="checkbox"
                  checked={!isExcluded}
                  onChange={() => toggle(n.id)}
                  title={isExcluded ? "Include in the wiki" : "Exclude from the wiki"}
                  style={{ flexShrink: 0, cursor: "pointer" }}
                />
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
                  disabled={isExcluded}
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
                    background: home === n.id ? "var(--color-accent-dim, var(--glass-hover))" : "transparent",
                    color: home === n.id ? "var(--color-accent)" : "var(--text-muted)",
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
        <Button variant="secondary" size="sm" loading={saving} disabled={!dirty} onClick={save}>
          Save content
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────── new publication ──

function NewPublication({
  tags,
  publishedTags,
  sharing,
  onPublished,
}: {
  tags: TagCount[];
  publishedTags: Set<string>;
  sharing: NonNullable<ReturnType<typeof useCollabSharing>>;
  onPublished: () => void | Promise<void>;
}) {
  const canPath = !!sharing.publishPath;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"tag" | "path">("tag");
  const [selectedTag, setSelectedTag] = useState<string[]>([]); // single-select via TagPicker
  const [pathPrefix, setPathPrefix] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; label: string; kind: "tag" | "path"; count: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const tag = selectedTag[0];
  const selectedCount = useMemo(() => tags.find((t) => t.tag === tag)?.count, [tags, tag]);
  const excluded = useMemo(() => publishedTags, [publishedTags]);

  const reset = () => {
    setOpen(false);
    setMode("tag");
    setSelectedTag([]);
    setPathPrefix("");
    setError(null);
    setResult(null);
    setCopied(false);
  };

  const canPublish = mode === "tag" ? !!tag : pathPrefix.trim().length > 0;

  const publish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    setError(null);
    try {
      if (mode === "path") {
        const prefix = pathPrefix.trim().replace(/^\/+/, "");
        const r = await sharing.publishPath!(prefix, { template: "wiki" });
        setResult({ url: r.url, label: r.pathPrefix || prefix, kind: "path", count: r.count });
      } else {
        const r = await sharing.publishTag!(tag!, { template: "wiki" });
        setResult({ url: r.url, label: `#${tag}`, kind: "tag", count: r.count });
      }
      await onPublished();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish this slice.");
    } finally {
      setPublishing(false);
    }
  };

  const copyUrl = () => {
    if (!result) return;
    void navigator.clipboard.writeText(result.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!open) {
    return (
      <div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>
          Publish a collection
        </Button>
      </div>
    );
  }

  return (
    <section
      style={{
        background: "var(--glass)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-lg, 14px)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionLabel>{result ? "Published" : "Publish a collection"}</SectionLabel>
        <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={reset}>
          {result ? "Done" : "Cancel"}
        </Button>
      </div>

      {result ? (
        // Success: immediately show the URL + copy.
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Badge variant="success">
              <Check size={11} /> Live
            </Badge>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              <span style={{ color: "var(--text-primary)" }}>{result.label}</span> is now a public Wiki.
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              readOnly
              value={result.url}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                padding: "8px 10px",
                borderRadius: 8,
                outline: "none",
                background: "var(--bg-surface, var(--glass))",
                border: "1px solid var(--glass-border)",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
              }}
            />
            <Button
              variant="primary"
              size="sm"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              onClick={copyUrl}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <a href={result.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <Button variant="secondary" size="sm" icon={<ExternalLink size={13} />}>
                Open
              </Button>
            </a>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Publishing <strong>{result.count}</strong> {result.count === 1 ? "note" : "notes"} —
            dynamic: future notes {result.kind === "path" ? "under" : "tagged"}{" "}
            <span style={{ color: "var(--text-secondary)" }}>{result.label}</span> are included too.
            Find it in the list above to set a title or password.
          </p>
        </div>
      ) : (
        <>
          {/* Tag | Path mode toggle. */}
          {canPath && (
            <div style={{ display: "flex", gap: 6 }}>
              <ModeTab active={mode === "tag"} onClick={() => setMode("tag")} icon={<Hash size={13} />} label="By tag" />
              <ModeTab active={mode === "path"} onClick={() => setMode("path")} icon={<FolderTree size={13} />} label="By folder" />
            </div>
          )}

          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            {mode === "tag"
              ? "Pick a tag to publish as a public, read-only Wiki."
              : "Publish every note under a folder (path prefix) as a public, read-only Wiki."}{" "}
            Nothing is shared until you press Publish.
          </p>

          {mode === "tag" ? (
            <TagPicker
              tags={tags}
              selected={selectedTag}
              onChange={setSelectedTag}
              multiple={false}
              exclude={excluded}
              maxHeight={220}
              autoFocus
              placeholder="Search tags…"
            />
          ) : (
            <Input
              icon={<FolderTree size={14} />}
              placeholder="e.g. projects/commons"
              value={pathPrefix}
              autoFocus
              onChange={(e) => setPathPrefix(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canPublish) void publish();
              }}
            />
          )}

          {/* Dynamic-count honesty for the pending selection. */}
          {mode === "tag" && tag && (
            <p
              style={{
                fontSize: 11.5,
                color: "var(--text-muted)",
                margin: 0,
                lineHeight: 1.5,
                padding: "8px 10px",
                background: "var(--glass-hover)",
                borderRadius: 8,
              }}
            >
              Publishing{" "}
              {selectedCount !== undefined ? <strong>{selectedCount}</strong> : "all"}{" "}
              {selectedCount === 1 ? "note" : "notes"} — dynamic: future notes tagged{" "}
              <span style={{ color: "var(--text-secondary)" }}>#{tag}</span> are included too.
            </p>
          )}
          {mode === "path" && pathPrefix.trim() && (
            <p
              style={{
                fontSize: 11.5,
                color: "var(--text-muted)",
                margin: 0,
                lineHeight: 1.5,
                padding: "8px 10px",
                background: "var(--glass-hover)",
                borderRadius: 8,
              }}
            >
              Publishing every note under{" "}
              <span style={{ color: "var(--text-secondary)" }}>{pathPrefix.trim().replace(/^\/+/, "")}</span>{" "}
              — dynamic: future notes under that folder are included too.
            </p>
          )}

          {error && <ErrText>{error}</ErrText>}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="primary"
              icon={<Globe size={15} />}
              loading={publishing}
              disabled={!canPublish}
              onClick={publish}
            >
              {mode === "tag" ? (tag ? `Publish #${tag}` : "Publish") : "Publish folder"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Small segmented-control tab for the Tag/Path publish modes. */
function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12.5,
        fontWeight: 550,
        padding: "6px 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--glass-border)"}`,
        background: active ? "var(--color-accent-dim, var(--glass-hover))" : "transparent",
        color: active ? "var(--color-accent)" : "var(--text-secondary)",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────── helpers ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 600,
        color: "var(--text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-secondary)" }}>{label}</div>
      {children}
      {hint && (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>{hint}</div>
      )}
    </div>
  );
}

function ErrText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--color-danger, #EB5757)" }}>{children}</div>
  );
}

function Spinner() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.25 }}
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.75 }}
      />
    </svg>
  );
}
