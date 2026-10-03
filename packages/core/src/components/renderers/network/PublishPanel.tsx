import "./publishing/publishing-studio.css";
// Publishing management; server membership is shared with the public reader.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Globe,
  Copy,
  Check,
  Trash2,
  Lock,
  ExternalLink,
  Settings2,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import {
  useCollabSharing,
  type PublicationInfo,
  type CollabSharing,
} from "../../../data/CollabSharing";
import { useVaultClient } from "../../../data/VaultClientContext";
import { useAgentChatStore } from "../../../lib/agent/chatStore";
import type { TagCount } from "../../../lib/types";
import { NewPublication } from "./publishing/NewPublication";
import { PublicationSettings } from "./publishing/PublicationSettings";
import { pubSlice, SectionLabel, Spinner } from "./publishing/shared";

export function PublishPanel() {
  const vault = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  return <ScopedPublishPanel key={vault.scope?.() ?? audience ?? "local"} />;
}

function ScopedPublishPanel() {
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
  const countEpoch = useRef(0);
  const refreshEpoch = useRef(0);

  const refresh = useCallback(async () => {
    if (!sharing?.listPublications) return;
    setError(null);
    const epoch = ++refreshEpoch.current;
    try {
      const list = await sharing.listPublications();
      if (epoch !== refreshEpoch.current) return;
      setPubs(list);
      return list;
    } catch (e) {
      if (epoch === refreshEpoch.current)
        setError(
          e instanceof Error ? e.message : "Couldn't load publications.",
        );
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
      countEpoch.current++;
      refreshEpoch.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Reader-authorized counts only; tag-picker totals include private/excluded
  // notes and cannot be presented as the number of published pages.
  const loadCounts = useCallback(
    async (pubList: PublicationInfo[]) => {
      const epoch = ++countEpoch.current;
      if (!sharing?.previewPublication) {
        setCounts({});
        return;
      }
      setCounts({});
      for (let i = 0; i < pubList.length; i += 4) {
        await Promise.all(
          pubList.slice(i, i + 4).map(async (pub) => {
            try {
              const preview = await sharing.previewPublication!(pub.slug);
              if (epoch === countEpoch.current)
                setCounts((c) => ({
                  ...c,
                  [pub.slug]: preview.publishedCount,
                }));
            } catch {
              /* An unavailable count stays unknown, never an invented zero. */
            }
          }),
        );
        if (epoch !== countEpoch.current) return;
      }
    },
    [sharing],
  );

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError(
        "The link could not be copied. Select the address and copy it manually.",
      );
      return;
    }
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

  const countFor = (pub: PublicationInfo) => counts[pub.slug];

  const publishedTags = useMemo(
    () =>
      new Set(
        pubs
          .filter((p) => p.kind !== "path" && p.isCurrentVault !== false)
          .map((p) => p.tag),
      ),
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
    <div
      className="prism-publications"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 28,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <style>{`.prism-publications button, .prism-publications input:not([type=checkbox]), .prism-publications select { min-height: 44px; } @media (max-width: 720px) { .prism-publications input:not([type=checkbox]), .prism-publications select { font-size: 16px; } }`}</style>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--color-danger, #EB5757)",
            background:
              "color-mix(in srgb, var(--color-danger, #EB5757) 10%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--color-danger, #EB5757) 30%, transparent)",
            borderRadius: "var(--radius-md, 10px)",
            padding: "10px 12px",
          }}
        >
          {error}
          <button
            className="ml-3 min-h-11 rounded-lg border border-[var(--glass-border)] px-3"
            onClick={() =>
              void refresh().then((list) => {
                if (list) void loadCounts(list);
              })
            }
          >
            Retry publications
          </button>
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
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: "var(--text-secondary)",
        }}
      >
        Nothing published yet.
      </div>
      <div style={{ fontSize: 12.5, maxWidth: 360 }}>
        Pick a tag below to turn that collection into a public, read-only Wiki.
        Future notes with the same tag are included automatically.
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
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [unpublishError, setUnpublishError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const unpublish = async () => {
    // Prefer the slug-based unpublish (works for tag + path); fall back to tag.
    if (!sharing.unpublish && !sharing.unpublishTag) return;
    setBusy(true);
    setUnpublishError("");
    try {
      if (sharing.unpublish) await sharing.unpublish(pub.slug);
      else await sharing.unpublishTag!(pub.tag);
      await onChanged();
      setConfirming(false);
    } catch (e) {
      setUnpublishError(
        e instanceof Error
          ? e.message
          : "The publication could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copyKey = `pub-${pub.slug}`;
  const slice = pubSlice(pub);
  const title = pub.title?.trim() || slice;

  return (
    <div
      data-pub-slug={pub.slug}
      className="prism-publication-card"
      style={{
        background: "var(--bg-surface)",
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
            background: "var(--action-bg, var(--color-accent))",
            color: "var(--action-fg, #fff)",
          }}
        >
          <Globe size={17} />
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 19,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
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
          <div
            style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}
          >
            {pub.vaultLabel && <span>{pub.vaultLabel} · </span>}
            <span style={{ color: "var(--text-secondary)" }}>{slice}</span>
            {" · "}
            {count !== undefined
              ? `${count} ${count === 1 ? "note" : "notes"}`
              : "live"}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a
            href={pub.url}
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "none" }}
          >
            <Button
              variant="secondary"
              size="sm"
              icon={<ExternalLink size={13} />}
            >
              Open
            </Button>
          </a>
          <Button
            variant="ghost"
            size="sm"
            icon={<Settings2 size={14} />}
            onClick={() => {
              setOpened(true);
              setOpen((o) => !o);
            }}
            aria-expanded={open}
          >
            Settings
          </Button>
        </div>
      </div>

      <details className="prism-publication-details">
        <summary className="focus-ring">
          {count !== undefined ? (
            <>
              <strong>{count}</strong> {count === 1 ? "page is" : "pages are"}{" "}
              currently visible.
            </>
          ) : (
            "Page count is unavailable."
          )}
          <span>Site address & membership</span>
        </summary>
        {/* URL + copy. */}
        <div
          style={{
            padding: "0 14px 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            readOnly
            aria-label="Publication address"
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

        <p className="prism-publication-membership">
          New eligible notes {pub.kind === "path" ? "under" : "tagged"}{" "}
          <span style={{ color: "var(--text-secondary)" }}>{slice}</span> are
          included automatically. Private notes stay excluded.
        </p>
      </details>

      {/* Expandable per-publication settings. */}
      {opened && (
        <div hidden={!open}>
          <PublicationSettings
            pub={pub}
            sharing={sharing}
            onChanged={onChanged}
          />
        </div>
      )}
      {unpublishError && (
        <p role="alert" className="px-4 text-sm text-[var(--color-error)]">
          {unpublishError}
        </p>
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
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginRight: "auto",
              }}
            >
              Unpublish {slice}? The public link stops working immediately.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              icon={<Trash2 size={13} />}
              onClick={unpublish}
              style={{
                background: "var(--color-danger, #EB5757)",
                color: "white",
              }}
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
