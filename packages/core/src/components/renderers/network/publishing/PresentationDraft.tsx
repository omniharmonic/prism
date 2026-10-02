import { PublicationNavigationEditor } from "./PublicationNavigationEditor";
import { Suspense, useEffect, useRef, useState } from "react";
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

export function PresentationDraft({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const [state, setState] = useState<PublicationPresentationState | null>(null);
  const [draft, setDraft] = useState<PublicationPresentation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState(false);
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <Field label="Site title">
              <Input
                aria-label="Draft site title"
                maxLength={200}
                value={draft.title ?? ""}
                onChange={(e) => update({ title: e.target.value || null })}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
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
                  <option value="docs">Documentation · focused reading</option>
                  <option value="landing">Landing · collection overview</option>
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
            <Field label="Logo URL" hint="HTTPS image, without credentials.">
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
                  theme({ font: e.target.value as PublicationTheme["font"] })
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
                  className="flex min-h-11 items-center gap-2 text-sm"
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
          <div className="flex flex-wrap items-center gap-2">
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
                onClick={() => setPreview(true)}
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
          <details className="rounded-lg border border-[var(--glass-border)] p-3">
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
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
                      {new Date(item.createdAt).toLocaleString()}
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
          {preview && Preview && (
            <Suspense fallback={<p role="status">Opening preview…</p>}>
              <Preview
                slug={pub.slug}
                draftRevision={state.draftRevision}
                onClose={() => setPreview(false)}
              />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
