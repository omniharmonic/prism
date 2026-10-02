import { useMemo, useRef, useState } from "react";
import {
  Plus,
  X,
  Globe,
  Check,
  Copy,
  ExternalLink,
  Hash,
  FolderTree,
} from "lucide-react";
import type { CollabSharing } from "../../../../data/CollabSharing";
import type { TagCount } from "../../../../lib/types";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import { TagPicker } from "../TagPicker";
import { Field, SectionLabel, ErrText } from "./shared";
export function NewPublication({
  tags,
  publishedTags,
  sharing,
  onPublished,
}: {
  tags: TagCount[];
  publishedTags: Set<string>;
  sharing: CollabSharing;
  onPublished: () => void | Promise<void>;
}) {
  const canPath = !!sharing.publishPath;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"tag" | "path">("tag");
  const [selectedTag, setSelectedTag] = useState<string[]>([]); // single-select via TagPicker
  const [pathPrefix, setPathPrefix] = useState("");
  const [publishing, setPublishing] = useState(false);
  const publishLock = useRef(false);
  const [protectedSite, setProtectedSite] = useState(false);
  const [initialPassword, setInitialPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    url: string;
    label: string;
    kind: "tag" | "path";
    count: number;
    passwordRequired: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const tag = selectedTag[0];
  const selectedCount = useMemo(
    () => tags.find((t) => t.tag === tag)?.count,
    [tags, tag],
  );
  const excluded = useMemo(() => publishedTags, [publishedTags]);

  const reset = () => {
    setOpen(false);
    setMode("tag");
    setSelectedTag([]);
    setPathPrefix("");
    setProtectedSite(false);
    setInitialPassword("");
    setError(null);
    setResult(null);
    setCopied(false);
  };

  const canPublish =
    (mode === "tag" ? !!tag : pathPrefix.trim().length > 0) &&
    (!protectedSite || initialPassword.length >= 8);

  const publish = async () => {
    if (!canPublish || publishLock.current) return;
    publishLock.current = true;
    setPublishing(true);
    setError(null);
    try {
      const options = {
        template: "wiki",
        ...(protectedSite ? { password: initialPassword } : {}),
      };
      if (mode === "path") {
        const prefix = pathPrefix.trim().replace(/^\/+/, "");
        const r = await sharing.publishPath!(prefix, options);
        setResult({
          url: r.url,
          label: r.pathPrefix || prefix,
          kind: "path",
          count: r.count,
          passwordRequired: r.passwordRequired,
        });
      } else {
        const r = await sharing.publishTag!(tag!, options);
        setResult({
          url: r.url,
          label: `#${tag}`,
          kind: "tag",
          count: r.count,
          passwordRequired: r.passwordRequired,
        });
      }
      setInitialPassword("");
      await onPublished();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish this slice.");
    } finally {
      publishLock.current = false;
      setPublishing(false);
    }
  };

  const copyUrl = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
    } catch {
      setError(
        "The link could not be copied. Select the address and copy it manually.",
      );
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!open) {
    return (
      <div>
        <Button
          variant="primary"
          icon={<Plus size={15} />}
          onClick={() => setOpen(true)}
        >
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <SectionLabel>
          {result ? "Published" : "Publish a collection"}
        </SectionLabel>
        <Button
          variant="ghost"
          size="sm"
          icon={<X size={14} />}
          disabled={publishing}
          onClick={reset}
        >
          {result ? "Done" : "Cancel"}
        </Button>
      </div>

      {result ? (
        // Success: immediately show the URL + copy.
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <Badge variant="success">
              <Check size={11} /> Live
            </Badge>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              <span style={{ color: "var(--text-primary)" }}>
                {result.label}
              </span>{" "}
              {result.passwordRequired
                ? "is now password protected."
                : "is now public."}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              readOnly
              aria-label="New publication address"
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
            <a
              href={result.url}
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
          </div>
          <p
            style={{
              fontSize: 11.5,
              color: "var(--text-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Publishing <strong>{result.count}</strong>{" "}
            {result.count === 1 ? "note" : "notes"} — dynamic: future notes{" "}
            {result.kind === "path" ? "under" : "tagged"}{" "}
            <span style={{ color: "var(--text-secondary)" }}>
              {result.label}
            </span>{" "}
            are included when eligible. Private notes stay excluded. Find this
            site above to customize it.
          </p>
        </div>
      ) : (
        <>
          {/* Tag | Path mode toggle. */}
          {canPath && (
            <div style={{ display: "flex", gap: 6 }}>
              <ModeTab
                active={mode === "tag"}
                onClick={() => setMode("tag")}
                icon={<Hash size={13} />}
                label="By tag"
              />
              <ModeTab
                active={mode === "path"}
                onClick={() => setMode("path")}
                icon={<FolderTree size={13} />}
                label="By folder"
              />
            </div>
          )}

          <p
            style={{
              fontSize: 12.5,
              color: "var(--text-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {mode === "tag"
              ? "Pick a tag to publish as a public, read-only Wiki."
              : "Publish eligible notes under a folder as a read-only Wiki."}{" "}
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
              aria-label="Publication folder"
              disabled={publishing}
              value={pathPrefix}
              autoFocus
              onChange={(e) => setPathPrefix(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canPublish) void publish();
              }}
            />
          )}

          <Field label="Reader access">
            <select
              aria-label="Reader access"
              disabled={publishing}
              value={protectedSite ? "password" : "public"}
              onChange={(event) =>
                setProtectedSite(event.target.value === "password")
              }
              className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] px-3 text-sm"
            >
              <option value="public">Public — anyone with the address</option>
              <option value="password">Password protected</option>
            </select>
          </Field>
          {protectedSite && (
            <Field
              label="Publication password"
              hint="Use at least 8 characters. The password is applied when the site is created."
            >
              <Input
                aria-label="New publication password"
                type="password"
                autoComplete="new-password"
                maxLength={256}
                disabled={publishing}
                value={initialPassword}
                onChange={(event) => setInitialPassword(event.target.value)}
              />
            </Field>
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
              {selectedCount !== undefined ? (
                <>
                  <strong>{selectedCount}</strong> notes match{" "}
                </>
              ) : (
                <>Collection: </>
              )}
              <span style={{ color: "var(--text-secondary)" }}>#{tag}</span>.
              Private notes stay excluded. Future eligible notes with this tag
              are included automatically.
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
              Publishing eligible notes under{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {pathPrefix.trim().replace(/^\/+/, "")}
              </span>{" "}
              — private notes stay excluded. Future eligible notes in this
              folder are included automatically.
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
              {mode === "tag"
                ? tag
                  ? `Publish #${tag}`
                  : "Publish"
                : "Publish folder"}
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
        background: active
          ? "var(--color-accent-dim, var(--glass-hover))"
          : "transparent",
        color: active ? "var(--color-accent)" : "var(--text-secondary)",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────── helpers ──
