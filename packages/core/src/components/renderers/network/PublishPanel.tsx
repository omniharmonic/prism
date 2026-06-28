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
  Search,
  X,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import { useCollabSharing, type PublicationInfo } from "../../../data/CollabSharing";
import { useVaultClient } from "../../../data/VaultClientContext";
import type { TagCount } from "../../../lib/types";

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
      if (list) void loadCounts(list.map((p) => p.tag));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Fetch live counts for a set of tags (used after publish/refresh).
  const loadCounts = useCallback(
    async (tagList: string[]) => {
      await Promise.all(
        tagList.map(async (tag) => {
          try {
            const notes = await vault.listNotes({ tag });
            setCounts((c) => ({ ...c, [tag]: notes.length }));
          } catch {
            /* leave undefined → falls back to picker count */
          }
        }),
      );
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

  // Resolve the best-known count for a tag: live count > picker count.
  const countFor = useCallback(
    (tag: string): number | undefined => {
      if (counts[tag] !== undefined) return counts[tag];
      return tags.find((t) => t.tag === tag)?.count;
    },
    [counts, tags],
  );

  const publishedTags = useMemo(() => new Set(pubs.map((p) => p.tag)), [pubs]);

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
                count={countFor(p.tag)}
                copied={copied}
                onCopy={copy}
                sharing={sharing}
                onChanged={async () => {
                  const list = await refresh();
                  if (list) void loadCounts(list.map((x) => x.tag));
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
        onPublished={async (tag) => {
          const list = await refresh();
          void loadCounts(list ? list.map((x) => x.tag) : [tag]);
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
    if (!sharing.unpublishTag) return;
    setBusy(true);
    try {
      await sharing.unpublishTag(pub.tag);
      await onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const copyKey = `pub-${pub.slug}`;
  const title = pub.title?.trim() || `#${pub.tag}`;

  return (
    <div
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
            <span style={{ color: "var(--text-secondary)" }}>#{pub.tag}</span>
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
        {count === 1 ? "note" : "notes"} — dynamic: future notes tagged{" "}
        <span style={{ color: "var(--text-secondary)" }}>#{pub.tag}</span> are included too.
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
              Unpublish #{pub.tag}? The public link stops working immediately.
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
    if (!sharing.publishTag || !titleDirty) return;
    setSavingTitle(true);
    setTitleError(null);
    try {
      // Re-publishing is idempotent — used here to update the title.
      await sharing.publishTag(pub.tag, { template: pub.template || "wiki", title: title.trim() });
      await onChanged();
    } catch (e) {
      setTitleError(e instanceof Error ? e.message : "Couldn't save the title.");
    } finally {
      setSavingTitle(false);
    }
  };

  const setPw = async (value: string | null) => {
    if (!sharing.setPublishPassword) return;
    setSavingPw(true);
    setPwError(null);
    try {
      await sharing.setPublishPassword(pub.tag, value);
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

      <div
        style={{
          fontSize: 11.5,
          color: "var(--text-muted)",
          borderTop: "1px dashed var(--glass-border)",
          paddingTop: 12,
        }}
      >
        More settings coming — home note, theme, and a custom URL slug.
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
  onPublished: (tag: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TagCount | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; tag: string; count: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tags
      .filter((t) => !publishedTags.has(t.tag))
      .filter((t) => (q ? t.tag.toLowerCase().includes(q) : true))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }, [tags, publishedTags, query]);

  const reset = () => {
    setOpen(false);
    setQuery("");
    setSelected(null);
    setError(null);
    setResult(null);
    setCopied(false);
  };

  const publish = async () => {
    if (!selected || !sharing.publishTag) return;
    setPublishing(true);
    setError(null);
    try {
      const r = await sharing.publishTag(selected.tag, { template: "wiki" });
      setResult({ url: r.url, tag: selected.tag, count: r.count });
      await onPublished(selected.tag);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish this tag.");
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
        <SectionLabel>
          {result ? "Published" : "Publish a collection"}
        </SectionLabel>
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
              <span style={{ color: "var(--text-primary)" }}>#{result.tag}</span> is now a public
              Wiki.
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
            dynamic: future notes tagged{" "}
            <span style={{ color: "var(--text-secondary)" }}>#{result.tag}</span> are included too.
            Find it in the list above to set a title or password.
          </p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Pick a tag to publish as a public, read-only Wiki. Nothing is shared until you press
            Publish.
          </p>

          {/* Searchable tag picker. */}
          <Input
            icon={<Search size={14} />}
            placeholder="Search tags…"
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
          />

          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid var(--glass-border)",
              borderRadius: 10,
              background: "var(--bg-surface, var(--glass))",
            }}
          >
            {available.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12.5, color: "var(--text-muted)" }}>
                {query ? "No matching tags." : "No tags available to publish."}
              </div>
            ) : (
              available.map((t) => {
                const active = selected?.tag === t.tag;
                return (
                  <button
                    key={t.tag}
                    onClick={() => setSelected(t)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "9px 12px",
                      background: active ? "var(--glass-hover)" : "transparent",
                      border: "none",
                      borderLeft: active
                        ? "2px solid var(--color-accent)"
                        : "2px solid transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      #{t.tag}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {t.count} {t.count === 1 ? "note" : "notes"}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Dynamic-count honesty for the pending selection. */}
          {selected && (
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
              Publishing <strong>{selected.count}</strong>{" "}
              {selected.count === 1 ? "note" : "notes"} — dynamic: future notes tagged{" "}
              <span style={{ color: "var(--text-secondary)" }}>#{selected.tag}</span> are included
              too.
            </p>
          )}

          {error && <ErrText>{error}</ErrText>}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="primary"
              icon={<Globe size={15} />}
              loading={publishing}
              disabled={!selected}
              onClick={publish}
            >
              {selected ? `Publish #${selected.tag}` : "Publish"}
            </Button>
          </div>
        </>
      )}
    </section>
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
