import { PresentationDraft } from "./PresentationDraft";
import { useMemo, useRef, useState } from "react";
import type { PublicationTheme } from "../../../../data/CollabSharing";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { Field, ErrText } from "./shared";
import type {
  CollabSharing,
  PublicationInfo,
} from "../../../../data/CollabSharing";
function cleanTheme(t: PublicationTheme): PublicationTheme {
  const out: PublicationTheme = {};
  if (t.logoUrl && t.logoUrl.trim()) out.logoUrl = t.logoUrl.trim();
  if (t.accent) out.accent = t.accent;
  if (t.bg) out.bg = t.bg;
  if (t.text) out.text = t.text;
  if (t.font) out.font = t.font;
  return out;
}

function LegacyPublicationAppearance({
  pub,
  sharing,
  onChanged,
}: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  const [theme, setThemeState] = useState<PublicationTheme>(pub.theme ?? {});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<PublicationTheme>) =>
    setThemeState((t) => ({ ...t, ...patch }));

  const initial = useMemo(
    () => JSON.stringify(cleanTheme(pub.theme ?? {})),
    [pub.theme],
  );
  const current = JSON.stringify(cleanTheme(theme));
  const dirty = current !== initial;

  const save = async () => {
    if (!sharing.updatePublicationSettings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const cleaned = cleanTheme(theme);
      await sharing.updatePublicationSettings(pub.slug, {
        theme: Object.keys(cleaned).length ? cleaned : null,
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save appearance.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!sharing.updatePublicationSettings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await sharing.updatePublicationSettings(pub.slug, { theme: null });
      setThemeState({});
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reset appearance.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        borderTop: "1px dashed var(--glass-border)",
        paddingTop: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--text-secondary)",
        }}
      >
        Appearance
      </div>
      <div
        style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}
      >
        Brand the public site. Any field left blank falls back to the default
        theme.
      </div>

      <Field
        label="Logo URL"
        hint="Shown in the site header. Must be an https:// image URL."
      >
        <Input
          aria-label="Publication logo URL"
          disabled={saving}
          placeholder="https://example.com/logo.png"
          value={theme.logoUrl ?? ""}
          onChange={(e) => set({ logoUrl: e.target.value })}
        />
      </Field>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <ColorField
          disabled={saving}
          label="Accent"
          value={theme.accent}
          fallback="#4f8cff"
          onChange={(v) => set({ accent: v })}
        />
        <ColorField
          disabled={saving}
          label="Background"
          value={theme.bg}
          fallback="#0e0e10"
          onChange={(v) => set({ bg: v })}
        />
        <ColorField
          disabled={saving}
          label="Text"
          value={theme.text}
          fallback="#ededed"
          onChange={(v) => set({ text: v })}
        />
      </div>

      <Field label="Font">
        <select
          aria-label="Publication font"
          disabled={saving}
          value={theme.font ?? ""}
          onChange={(e) =>
            set({
              font: (e.target.value || undefined) as PublicationTheme["font"],
            })
          }
          style={{
            fontSize: 12.5,
            padding: "7px 10px",
            borderRadius: 8,
            background: "var(--bg-surface, var(--glass))",
            border: "1px solid var(--glass-border)",
            color: "var(--text-secondary)",
            outline: "none",
            maxWidth: 220,
          }}
        >
          <option value="">Default</option>
          <option value="sans">Sans-serif</option>
          <option value="serif">Serif</option>
          <option value="mono">Monospace</option>
        </select>
      </Field>

      {error && <ErrText>{error}</ErrText>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" size="sm" disabled={saving} onClick={reset}>
          Reset to default
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={saving}
          disabled={!dirty}
          onClick={save}
        >
          Save appearance
        </Button>
      </div>
    </div>
  );
}

/** A labeled color swatch + picker. Shows `fallback` when unset, but only writes
 *  a value into the theme once the owner actually picks one. */
function ColorField({
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        {label}
      </span>
      <input
        type="color"
        disabled={disabled}
        aria-label={label + " color"}
        value={value ?? fallback}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 48,
          height: 30,
          padding: 0,
          border: "1px solid var(--glass-border)",
          borderRadius: 8,
          background: "transparent",
          cursor: "pointer",
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────── publication content ──
// Lets the owner pick the landing note and exclude individual notes from the
// public set when the tag/path heuristic sweeps in something that shouldn't be
// public (or renders messily). Owner-only; uses the full vault to enumerate the
// candidate set (including currently-excluded notes, so they can be re-included).

export function PublicationAppearance(props: {
  pub: PublicationInfo;
  sharing: CollabSharing;
  onChanged: () => void | Promise<void>;
}) {
  return props.sharing.getPublicationPresentation &&
    props.sharing.savePublicationPresentation &&
    props.sharing.publishPublicationPresentation &&
    props.sharing.restorePublicationPresentation ? (
    <PresentationDraft {...props} />
  ) : (
    <LegacyPublicationAppearance {...props} />
  );
}
