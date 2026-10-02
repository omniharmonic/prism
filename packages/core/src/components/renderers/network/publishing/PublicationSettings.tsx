import { useId, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { Field, ErrText, pubSlice } from "./shared";
import { PublicationAppearance } from "./PublicationAppearance";
import { PublicationContent } from "./PublicationContent";
import type {
  CollabSharing,
  PublicationInfo,
} from "../../../../data/CollabSharing";
export function PublicationSettings({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState(pub.title ?? "");
  const [section, setSection] = useState("details");
  const sectionId = useId();
  const sections = [
    ["details", "Site details"],
    ["appearance", "Appearance"],
    ["content", "Content"],
    ["access", "Access"],
  ] as const;
  const [savingTitle, setSavingTitle] = useState(false);
  const titleLock = useRef(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const passwordLock = useRef(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const titleDirty = (title.trim() || null) !== (pub.title?.trim() || null);

  const saveTitle = async () => {
    if (!titleDirty || titleLock.current) return;
    titleLock.current = true;
    setSavingTitle(true);
    setTitleError(null);
    try {
      // Title is a per-publication SETTING — update it by slug. (Re-publishing an
      // existing tag/path only updated the password, so the title never stuck.)
      if (sharing.updatePublicationSettings) {
        await sharing.updatePublicationSettings(pub.slug, {
          title: title.trim() || null,
        });
      } else {
        const opts = { template: pub.template || "wiki", title: title.trim() };
        if (pub.kind === "path")
          await sharing.publishPath?.(pub.pathPrefix ?? "", opts);
        else await sharing.publishTag?.(pub.tag, opts);
      }
      await onChanged();
    } catch (e) {
      setTitleError(
        e instanceof Error ? e.message : "Couldn't save the title.",
      );
    } finally {
      titleLock.current = false;
      setSavingTitle(false);
    }
  };

  const setPw = async (value: string | null) => {
    if (passwordLock.current) return;
    passwordLock.current = true;
    setSavingPw(true);
    setPwError(null);
    try {
      // Prefer the slug-based setter (tag + path); fall back to the tag setter.
      if (sharing.setPublicationPassword)
        await sharing.setPublicationPassword(pub.slug, value);
      else await sharing.setPublishPassword?.(pub.tag, value);
      setPassword("");
      await onChanged();
    } catch (e) {
      setPwError(
        e instanceof Error ? e.message : "Couldn't update the password.",
      );
    } finally {
      passwordLock.current = false;
      setSavingPw(false);
    }
  };

  return (
    <div
      className="prism-publication-settings"
      style={{
        borderTop: "1px solid var(--glass-border)",
        background: "var(--bg-surface)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        role="tablist"
        aria-label="Publication settings"
        className="prism-publication-tabs"
      >
        {sections.map(([id, label], index) => (
          <button
            key={id}
            role="tab"
            id={`${sectionId}-tab-${id}`}
            aria-controls={`${sectionId}-panel-${id}`}
            aria-selected={section === id}
            tabIndex={section === id ? 0 : -1}
            className="focus-ring"
            onClick={() => setSection(id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % sections.length
                  : event.key === "ArrowLeft"
                    ? (index + sections.length - 1) % sections.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? sections.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              setSection(sections[next]![0]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
                [next]?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--text-secondary)]">
        {sharing.getPublicationPresentation
          ? "Appearance uses private drafts and an explicit publish step. Content and access apply when saved."
          : "Changes apply to the live site when you save."}{" "}
        Switching sections keeps your unsaved settings here.
      </p>
      <section
        role="tabpanel"
        id={`${sectionId}-panel-details`}
        aria-labelledby={`${sectionId}-tab-details`}
        hidden={section !== "details"}
      >
        {sharing.getPublicationPresentation ? (
          <div className="space-y-3 text-sm">
            <p className="font-medium">{pub.title || pubSlice(pub)}</p>
            <p className="break-all text-[var(--text-secondary)]">{pub.url}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSection("appearance")}
            >
              Edit title and appearance
            </Button>
          </div>
        ) : (
          <Field
            label="Title"
            hint="Shown as the Wiki's heading. Defaults to the tag name."
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 180 }}>
                <Input
                  disabled={savingTitle}
                  aria-label="Publication title"
                  value={title}
                  placeholder={pub.title || pubSlice(pub)}
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
        )}
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-panel-access`}
        aria-labelledby={`${sectionId}-tab-access`}
        hidden={section !== "access"}
      >
        {/* Password */}
        <Field
          label="Password"
          hint={
            pub.passwordRequired
              ? "This Wiki requires a password. Clear it to make it fully public."
              : "Optional. Add a password to gate the public link."
          }
        >
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 180 }}>
              <Input
                type="password"
                disabled={savingPw}
                aria-label="Publication password"
                value={password}
                placeholder={
                  pub.passwordRequired ? "Set a new password" : "Add a password"
                }
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
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-panel-appearance`}
        aria-labelledby={`${sectionId}-tab-appearance`}
        hidden={section !== "appearance"}
      >
        {/* Appearance: per-publication logo + colors + font. */}
        {sharing.updatePublicationSettings && (
          <PublicationAppearance
            pub={pub}
            sharing={sharing}
            onChanged={onChanged}
          />
        )}
      </section>
      <section
        role="tabpanel"
        id={`${sectionId}-panel-content`}
        aria-labelledby={`${sectionId}-tab-content`}
        hidden={section !== "content"}
      >
        {/* Per-publication content tending: home note + hand-exclude notes. */}
        {sharing.updatePublicationSettings && (
          <PublicationContent
            pub={pub}
            sharing={sharing}
            onChanged={onChanged}
          />
        )}
      </section>
    </div>
  );
}

// ──────────────────────────────────────────────────── publication appearance ──
// Lets the owner brand the public wiki: a logo, accent/background/text colors,
// and a body font. Persisted as the publication's `theme` (a small JSON blob);
// every value is re-validated at render on the public site (http(s) logo, color
// patterns) so an owner can't inject markup into a public page. Partial themes
// are fine — any unset field falls back to the site default.

/** Strip undefined/empty values so a "no overrides" theme serializes to {}. */
