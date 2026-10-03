import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COVER_GRADIENTS, gradientCss, safeMediaSrc, MAX_IMAGE_BYTES, type PageCover as Cover } from "../../lib/media/attachments";

/**
 * Notion-style page cover (NP-PG-02): a full-bleed band above the title.
 * Presets (brand gradients), upload, or a link; Reposition by dragging the
 * image vertically (keyboard: ↑/↓) then Save; Change / Remove. Read-only pages
 * show the cover with no controls. Rendered as an <img> (not a CSS background)
 * so the native client's image proxy/observer applies to it too.
 *
 * The host persists `onChange(cover | null)` into metadata (`coverPatch`).
 */
export function PageCover({
  cover,
  onChange,
  onUpload,
}: {
  cover: Cover | null;
  /** Omit on read-only surfaces. */
  onChange?: (cover: Cover | null) => void;
  /** Store an image and return its URL. Omit → the Upload tab is hidden. */
  onUpload?: (file: File) => Promise<string>;
}) {
  const [picker, setPicker] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [y, setY] = useState(cover?.y ?? 50);
  const [failed, setFailed] = useState(false);
  const bandRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const editable = !!onChange;

  useEffect(() => { if (!repositioning) setY(cover?.y ?? 50); }, [cover?.y, repositioning]);
  useEffect(() => setFailed(false), [cover?.value]);

  if (!cover) return null;
  const gradient = cover.kind === "gradient" ? gradientCss(cover.value) : null;
  const src = cover.kind === "image" ? safeMediaSrc(cover.value) : null;

  const drag = (e: React.PointerEvent) => {
    if (!repositioning || !bandRef.current) return;
    e.preventDefault();
    const band = bandRef.current;
    const startY = e.clientY;
    const start = y;
    const h = band.getBoundingClientRect().height || 1;
    band.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => setY(Math.max(0, Math.min(100, Math.round(start - ((ev.clientY - startY) / h) * 100))));
    const up = () => {
      band.removeEventListener("pointermove", move);
      band.removeEventListener("pointerup", up);
      band.removeEventListener("pointercancel", up);
    };
    band.addEventListener("pointermove", move);
    band.addEventListener("pointerup", up);
    band.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={bandRef}
      className="document-cover"
      data-kind={cover.kind}
      data-repositioning={repositioning || undefined}
      style={gradient ? { background: gradient } : undefined}
      onPointerDown={drag}
      tabIndex={repositioning ? 0 : -1}
      aria-label={repositioning ? "Drag to reposition the cover, or use the arrow keys" : undefined}
      onKeyDown={(e) => {
        if (!repositioning) return;
        if (e.key === "ArrowUp") { e.preventDefault(); setY((v) => Math.min(100, v + 5)); }
        if (e.key === "ArrowDown") { e.preventDefault(); setY((v) => Math.max(0, v - 5)); }
        if (e.key === "Enter") { e.preventDefault(); onChange?.({ ...cover, y }); setRepositioning(false); }
        if (e.key === "Escape") { e.preventDefault(); setY(cover.y); setRepositioning(false); }
      }}
    >
      {src && !failed && (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} style={{ objectPosition: `50% ${y}%` }} />
      )}
      {src && failed && <span className="document-cover-missing">Cover image unavailable</span>}
      {editable && (
        <div className="document-cover-controls" onPointerDown={(e) => e.stopPropagation()}>
          {repositioning ? (
            <>
              <span className="document-cover-hint">Drag image to reposition</span>
              <button type="button" className="document-cover-button focus-ring" onClick={() => { onChange?.({ ...cover, y }); setRepositioning(false); }}>Save position</button>
              <button type="button" className="document-cover-button focus-ring" onClick={() => { setY(cover.y); setRepositioning(false); }}>Cancel</button>
            </>
          ) : (
            <>
              <button ref={changeRef} type="button" className="document-cover-button focus-ring" aria-haspopup="dialog" aria-expanded={picker} onClick={() => setPicker((v) => !v)}>Change cover</button>
              {src && !failed && (
                <button type="button" className="document-cover-button focus-ring" onClick={() => { setRepositioning(true); requestAnimationFrame(() => bandRef.current?.focus()); }}>Reposition</button>
              )}
              <button type="button" className="document-cover-button focus-ring" onClick={() => onChange?.(null)}>Remove</button>
            </>
          )}
        </div>
      )}
      {picker && editable && (
        <CoverPicker
          anchor={changeRef.current}
          current={cover}
          onUpload={onUpload}
          onPick={(next) => { onChange?.(next); setPicker(false); }}
          onRemove={() => { onChange?.(null); setPicker(false); }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

type Tab = "gallery" | "upload" | "link";

/** Gallery / Upload / Link popover. Also used by the "Add cover" flow. */
export function CoverPicker({
  anchor,
  current,
  onPick,
  onRemove,
  onUpload,
  onClose,
}: {
  anchor: HTMLElement | null;
  current: Cover | null;
  onPick: (cover: Cover) => void;
  onRemove?: () => void;
  onUpload?: (file: File) => Promise<string>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("gallery");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const r = anchor?.getBoundingClientRect();
  const width = Math.min(420, window.innerWidth - 16);
  const top = r ? Math.min(r.bottom + 6, window.innerHeight - 340) : 80;
  const left = r ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) : 8;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); anchor?.focus(); } };
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, anchor]);

  const upload = async (file: File | undefined) => {
    if (!file || !onUpload) return;
    setError("");
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) { setError("Choose a PNG, JPEG, GIF, WebP or AVIF image."); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError(`Images must be under ${Math.round(MAX_IMAGE_BYTES / 1_048_576)} MB.`); return; }
    setBusy(true);
    try {
      const url = await onUpload(file);
      onPick({ kind: "image", value: url, y: 50 });
    } catch {
      setError("Couldn't upload that image. The cover is unchanged.");
    } finally {
      setBusy(false);
    }
  };
  const submitLink = () => {
    const src = safeMediaSrc(link);
    if (!src || !/^https:\/\//i.test(src)) { setError("Paste an https:// image link."); return; }
    onPick({ kind: "image", value: src, y: 50 });
  };

  const tabs: Array<[Tab, string]> = [["gallery", "Gallery"], ...(onUpload ? [["upload", "Upload"] as [Tab, string]] : []), ["link", "Link"]];
  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 70 }} onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-label="Page cover" className="document-cover-picker glass-elevated" style={{ position: "fixed", top, left, width, zIndex: 71 }}>
        <div className="document-cover-picker-tabs" role="tablist" aria-label="Cover source">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="focus-ring" onClick={() => { setTab(id); setError(""); }}>{label}</button>
          ))}
          {onRemove && current && <button type="button" className="document-cover-picker-remove focus-ring" onClick={onRemove}>Remove</button>}
        </div>
        {tab === "gallery" && (
          <div className="document-cover-gallery" role="list" aria-label="Brand gradients">
            {COVER_GRADIENTS.map((g) => (
              <button
                key={g.name}
                type="button"
                role="listitem"
                className="document-cover-swatch focus-ring"
                aria-label={`${g.label} gradient`}
                aria-pressed={current?.kind === "gradient" && current.value === g.name}
                title={g.label}
                style={{ background: g.css }}
                onClick={() => onPick({ kind: "gradient", value: g.name, y: 50 })}
              />
            ))}
          </div>
        )}
        {tab === "upload" && onUpload && (
          <div className="document-cover-pane">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden onChange={(e) => void upload(e.target.files?.[0])} aria-label="Cover image file" />
            <button type="button" className="document-cover-primary focus-ring" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading…" : "Upload an image"}</button>
            <p className="document-cover-help">Images wider than 1500 px work best. Up to {Math.round(MAX_IMAGE_BYTES / 1_048_576)} MB.</p>
          </div>
        )}
        {tab === "link" && (
          <form className="document-cover-pane" onSubmit={(e) => { e.preventDefault(); submitLink(); }}>
            <input type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste an image link…" aria-label="Image link" className="document-cover-input" autoFocus />
            <button type="submit" className="document-cover-primary focus-ring" disabled={!link.trim()}>Use link</button>
          </form>
        )}
        {error && <p role="alert" className="document-cover-error">{error}</p>}
      </div>
    </>,
    document.body,
  );
}
