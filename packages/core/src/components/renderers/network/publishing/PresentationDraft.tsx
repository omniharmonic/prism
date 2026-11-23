import { PublicationNavigationEditor } from "./PublicationNavigationEditor";
import { parsePublicationNavigation } from "../../../../lib/publishing/navigation";
import { Eye, Globe, FileText } from "lucide-react";
import "./publishing-studio.css";
import { Suspense, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import type {
  CollabSharing,
  PublicationInfo,
  PublicationPresentation,
  PublicationPresentationState,
  PublicationTheme,
} from "../../../../data/CollabSharing";
import { usePublicationPreview } from "../../../../data/PublicationPreviewContext";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { ErrText, Field } from "./shared";

import { formatDateTime as fmtDateTime } from "../../../../lib/datetime/format";
export function PresentationDraft({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const paneId = useId();
  const [mobilePane, setMobilePane] = useState<"settings" | "preview">(
    "settings",
  );
  const [state, setState] = useState<PublicationPresentationState | null>(null);
  const [draft, setDraft] = useState<PublicationPresentation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<"closed" | "inline" | "dialog">(
    "closed",
  );
  const previewReturn = useRef<"closed" | "inline">("closed");
  const previewLaunch = useRef<HTMLButtonElement | null>(null);
  const studio = useRef<HTMLDivElement>(null);
  const focusAfterClose = useRef(false);
  function closePreview() {
    if (preview === "dialog" && previewReturn.current === "inline") {
      previewReturn.current = "closed";
      setPreview("inline");
      return;
    }
    focusAfterClose.current = true;
    setPreview("closed");
  }
  // The launcher remounts on close; focus only after its pane is committed visible.
  useLayoutEffect(() => {
    if (preview !== "closed" || !focusAfterClose.current) return;
    const launcher = previewLaunch.current?.isConnected
      ? previewLaunch.current
      : studio.current?.querySelector<HTMLButtonElement>("[data-inline-preview]");
    if (launcher?.disabled && mobilePane !== "settings") {
      setMobilePane("settings");
      return;
    }
    const target = launcher?.disabled
      ? studio.current?.querySelector<HTMLInputElement>('[aria-label="Draft site title"]')
      : launcher;
    focusAfterClose.current = false;
    target?.focus({ preventScroll: true });
  }, [preview, mobilePane]);

  const lock = useRef(false);
  const generation = useRef(0);
  const Preview = usePublicationPreview();
  useEffect(() => {
    const epoch = ++generation.current;
    setError("");
    sharing.getPublicationPresentation!(pub.slug)
      .then((value) => {
        if (epoch !== generation.current) return;
        setState(value);
        setDraft(value.draft ?? value.live);
        if (!value.draft) setPreview("closed");
      })
      .catch((e) => {
        if (epoch === generation.current)
          setError(
            e instanceof Error ? e.message : "Could not load site revisions.",
          );
      });
    return () => {
      generation.current++;
    };
  }, [sharing, pub.slug, refresh]);
  const baseline = state?.draft ?? state?.live;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline);
  const stale =
    !!state?.draft && state.draftBaseRevision !== state.liveRevision;
  const update = (patch: Partial<PublicationPresentation>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));
  const theme = (patch: Partial<PublicationTheme>) =>
    setDraft((d) => (d ? { ...d, theme: { ...d.theme, ...patch } } : d));
  async function act(
    action: "save" | "publish" | "restore",
    revision?: number,
  ) {
    if (!state || !draft || lock.current) return;
    if (
      action === "save" &&
      draft.theme?.navigation &&
      !parsePublicationNavigation(draft.theme.navigation)
    ) {
      setError(
        "Name every navigation section. Use up to 8 sections and 64 unique eligible pages.",
      );
      return;
    }
    if (
      action === "save" &&
      draft.theme &&
      new TextEncoder().encode(JSON.stringify(draft.theme)).length > 4096
    ) {
      setError(
        "Site settings exceed the 4 KB limit. Shorten navigation labels or image URLs, or use fewer navigation pages. Your draft is still here.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      const next =
        action === "save"
          ? await sharing.savePublicationPresentation!(
              pub.slug,
              draft,
              state.draftRevision,
              state.liveRevision,
            )
          : action === "publish"
            ? await sharing.publishPublicationPresentation!(
                pub.slug,
                state.draftRevision,
                state.liveRevision,
              )
            : await sharing.restorePublicationPresentation!(
                pub.slug,
                revision!,
                state.draftRevision,
                state.liveRevision,
              );
      if (epoch !== generation.current) return;
      setState(next);
      setDraft(next.draft ?? next.live);
      if (!next.draft) setPreview("closed");
      if (action === "publish") await onChanged();
    } catch (e) {
      if (epoch === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "Could not save these settings. Your draft is still here.",
        );
    } finally {
      lock.current = false;
      if (epoch === generation.current) setBusy(false);
    }
  }
  return (
    <div ref={studio} className="prism-site-studio">
      <div className="prism-site-studio-heading">
        <div>
          <h3 className="text-sm font-semibold">Site studio</h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Save a private draft, preview it, then publish its appearance.
            Document edits remain live.
          </p>
        </div>
        {state && (
          <span className="rounded-full bg-[var(--glass)] px-3 py-1 text-xs">
            Live revision {state.liveRevision}
          </span>
        )}
      </div>
      {error && <ErrText>{error}</ErrText>}
      {(!state || error) && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {state
            ? "Reload revisions and replace this draft"
            : "Retry loading revisions"}
        </Button>
      )}
      {!state || !draft ? (
        <p className="text-sm text-[var(--text-secondary)]">
          {error
            ? "Site revisions are unavailable."
            : "Loading site revisions…"}
        </p>
      ) : (
        <>
          {stale && (
            <p
              role="status"
              className="rounded-lg border border-[var(--glass-border)] p-3 text-sm"
            >
              The live site changed after this draft. Review your choices and
              save a new draft before publishing.
            </p>
          )}
          <div className="prism-site-studio-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || (!dirty && !!state.draft && !stale)}
              onClick={() => void act("save")}
            >
              Save private draft
            </Button>
            {Preview && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || dirty || !state.draft}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  previewLaunch.current = event.currentTarget;
                  previewReturn.current = "closed";
                  setPreview("dialog");
                }}
              >
                Preview saved draft
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={busy || dirty || stale || !state.draft}
              onClick={() => void act("publish")}
            >
              Publish appearance
            </Button>
            <span
              role="status"
              className="text-xs text-[var(--text-secondary)]"
            >
              {busy
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : state.draft
                    ? "Private draft saved"
                    : "Live appearance"}
            </span>
          </div>
          <div
            className="prism-site-studio-switch"
            role="group"
            aria-label="Studio view"
          >
            <button
              type="button"
              className="focus-ring"
              aria-pressed={mobilePane === "settings"}
              aria-controls={`${paneId}-settings`}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setMobilePane("settings");
              }}
            >
              Settings view
            </button>
            <button
              type="button"
              className="focus-ring"
              aria-pressed={mobilePane === "preview"}
              aria-controls={`${paneId}-preview`}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setMobilePane("preview");
              }}
            >
              Preview view
            </button>
          </div>
          <div className="prism-site-studio-grid" data-mobile-pane={mobilePane}>
            <div
              id={`${paneId}-settings`}
              className="prism-site-studio-settings"
            >
              <h4>Site settings</h4>
              <p className="prism-site-studio-hint">
                Shape how your collection looks and reads.
              </p>
              <fieldset disabled={busy} className="min-w-0 space-y-4">
                <Field label="Site title">
                  <Input
                    aria-label="Draft site title"
                    maxLength={200}
                    value={draft.title ?? ""}
                    onChange={(e) => update({ title: e.target.value || null })}
                  />
                </Field>
                <div className="prism-site-layout-controls">
                  <Field label="Layout">
                    <select
                      aria-label="Publication layout"
                      className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
                      value={draft.template}
                      onChange={(e) =>
                        update({
                          template: e.target
                            .value as PublicationPresentation["template"],
                        })
                      }
                    >
                      <option value="wiki">Wiki · connected knowledge</option>
                      <option value="docs">
                        Documentation · focused reading
                      </option>
                      <option value="landing">
                        Landing · collection overview
                      </option>
                    </select>
                  </Field>
                  <Field label="Reading width">
                    <select
                      aria-label="Publication reading width"
                      className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
                      value={draft.theme?.contentWidth ?? "reading"}
                      onChange={(e) =>
                        theme({
                          contentWidth: e.target.value as "reading" | "wide",
                        })
                      }
                    >
                      <option value="reading">Comfortable</option>
                      <option value="wide">Wide</option>
                    </select>
                  </Field>
                </div>
                <Field label="Introduction">
                  <Input
                    aria-label="Publication introduction"
                    maxLength={500}
                    value={draft.theme?.description ?? ""}
                    onChange={(e) => theme({ description: e.target.value })}
                  />
                </Field>
                <Field
                  label="Logo URL"
                  hint="HTTPS image, without credentials."
                >
                  <Input
                    aria-label="Publication logo URL"
                    value={draft.theme?.logoUrl ?? ""}
                    onChange={(e) => theme({ logoUrl: e.target.value })}
                  />
                </Field>
                <Field
                  label="Cover URL"
                  hint="An optional HTTPS image above your home page."
                >
                  <Input
                    aria-label="Publication cover URL"
                    value={draft.theme?.coverUrl ?? ""}
                    onChange={(e) => theme({ coverUrl: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  {(
                    [
                      ["accent", "Accent"],
                      ["bg", "Background"],
                      ["text", "Text"],
                    ] as const
                  ).map(([key, label]) => (
                    <Field key={key} label={label}>
                      <Input
                        className="w-full min-w-0"
                        aria-label={label + " color"}
                        placeholder="Default"
                        value={draft.theme?.[key] ?? ""}
                        onChange={(e) => {
                          const next = { ...draft.theme };
                          if (e.target.value) next[key] = e.target.value;
                          else delete next[key];
                          update({ theme: next });
                        }}
                      />
                    </Field>
                  ))}
                </div>
                <Field label="Font">
                  <select
                    aria-label="Publication font"
                    className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
                    value={draft.theme?.font ?? "sans"}
                    onChange={(e) =>
                      theme({
                        font: e.target.value as PublicationTheme["font"],
                      })
                    }
                  >
                    <option value="sans">Sans-serif</option>
                    <option value="serif">Serif</option>
                    <option value="mono">Monospace</option>
                  </select>
                </Field>
                <div className="flex flex-wrap gap-4">
                  {(
                    [
                      ["showSearch", "Site search"],
                      ["showGraph", "Knowledge graph"],
                      ["showMap", "Map views"],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex min-h-control items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={draft.theme?.[key] !== false}
                        onChange={(e) => theme({ [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {sharing.previewPublication && (
                  <PublicationNavigationEditor
                    key={pub.slug}
                    slug={pub.slug}
                    sharing={sharing}
                    value={draft.theme?.navigation}
                    onChange={(navigation) => {
                      const next = { ...draft.theme };
                      if (navigation) next.navigation = navigation;
                      else delete next.navigation;
                      update({ theme: next });
                    }}
                  />
                )}
              </fieldset>
              <div className="prism-site-revisions">
                <div>
                  <Globe size={16} aria-hidden="true" />
                  <span>
                    <strong>Published version</strong>
                    <small>
                      Live revision {state.liveRevision} ·{" "}
                      {state.live.title || "Untitled site"}
                    </small>
                  </span>
                  <a
                    className="focus-ring"
                    href={pub.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View live site
                  </a>
                </div>
                <div>
                  <FileText size={16} aria-hidden="true" />
                  <span>
                    <strong>
                      {dirty
                        ? "Unsaved appearance"
                        : state.draft
                          ? "Private draft"
                          : "No saved draft"}
                    </strong>
                    <small>
                      {dirty
                        ? "Your local edits are not shown in the saved preview."
                        : state.draft
                          ? `Saved draft revision ${state.draftRevision}. The live appearance has not changed.`
                          : "Save a private draft before previewing changes."}
                    </small>
                  </span>
                </div>
              </div>
            </div>
            <aside
              id={`${paneId}-preview`}
              className="prism-site-studio-review"
              aria-label="Appearance review"
            >
              {preview !== "closed" && dirty && (
                <p className="prism-site-preview-stale" role="status">
                  Preview shows saved draft {state.draftRevision}. Unsaved
                  settings are not shown.
                </p>
              )}
              {preview === "closed" ? (
                <div className="prism-site-preview-empty">
                  <Eye size={28} aria-hidden="true" />
                  <h4>Preview your saved draft</h4>
                  <p>
                    Open the actual reader with the saved appearance and
                    currently eligible pages. Previewing never publishes
                    changes.
                  </p>
                  {Preview ? (
                    <Button
                      data-inline-preview
                      variant="secondary"
                      size="sm"
                      disabled={busy || dirty || !state.draft}
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        previewLaunch.current = event.currentTarget;
                        previewReturn.current = "closed";
                        setMobilePane("preview");
                        setPreview("inline");
                      }}
                    >
                      Show preview in studio
                    </Button>
                  ) : (
                    <p>Private preview is not available in this app.</p>
                  )}
                </div>
              ) : (
                Preview && (
                  <Suspense fallback={<p role="status">Opening preview…</p>}>
                    <Preview
                      slug={pub.slug}
                      draftRevision={state.draftRevision}
                      inline={preview === "inline"}
                      onExpand={() => {
                        previewReturn.current = "inline";
                        setPreview("dialog");
                      }}
                      onClose={closePreview}
                    />
                  </Suspense>
                )
              )}
            </aside>
          </div>
          <details className="rounded-lg border border-[var(--glass-border)] p-3">
            <summary className="min-h-control cursor-pointer text-sm font-medium">
              Appearance history ({state.history.length})
            </summary>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Restore creates a draft to review. It never changes documents,
              passwords or page visibility.
            </p>
            <ul className="space-y-2">
              {state.history.map((item) => (
                <li
                  key={item.revision}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--glass-border)] py-2 text-sm"
                >
                  <span>
                    Revision {item.revision} ·{" "}
                    {item.presentation.title || "Untitled site"}
                    <small className="block text-[var(--text-secondary)]">
                      {fmtDateTime(new Date(item.createdAt))}
                    </small>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || dirty}
                    onClick={() => void act("restore", item.revision)}
                  >
                    Restore revision {item.revision} as draft
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
