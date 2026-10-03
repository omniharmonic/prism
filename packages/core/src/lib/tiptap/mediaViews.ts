/**
 * Browser node views for the v3 blocks (images, files, embeds, bookmarks,
 * table of contents, code). Importing this module registers them with the
 * isomorphic schema in `editor/blocks.ts`; the server never imports it, so it
 * renders the same nodes through their plain `renderHTML`.
 *
 * Plain DOM (no React roots per node): node views are created and destroyed
 * constantly while typing and in live collaboration; a DOM view is cheap and
 * can't leak a React tree. Every attribute write goes through ONE
 * `setNodeMarkup` transaction (one undo step, one Yjs update), only while the
 * editor is editable and not in suggest/comment-only mode.
 */
import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { registerBlockViews, codeLanguages } from "../../editor/blocks";
import { embedFor, EMBED_SANDBOX, isAllowedFrameSrc, safeWebUrl } from "../media/embeds";
import { formatBytes, isDangerousImageSrc, isOwnAttachment, ownOrProxiedSrc, safeAttachmentSrc } from "../media/attachments";
import { serverFetch } from "../transport/serverFetch";
import { structuralEditsAllowed } from "./blockCommands";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SVG: Record<string, string> = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h16"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M4 18h16"/>',
  alignRight: '<path d="M4 6h16M10 12h10M4 18h16"/>',
  wide: '<path d="M3 12h18"/><path d="m6 9-3 3 3 3M18 9l3 3-3 3"/>',
  caption: '<path d="M4 6h16v9H4z"/><path d="M7 19h10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4"/><path d="m14 16-2 2 2 2"/><path d="M4 18h5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};

function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function icon(doc: Document, name: keyof typeof SVG, size = 16): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = SVG[name]; // static strings only
  return svg;
}

function button(doc: Document, label: string, name: keyof typeof SVG | null, cls = "prism-media-btn"): HTMLButtonElement {
  const b = h(doc, "button", cls, { type: "button", "aria-label": label, title: label });
  if (name) b.append(icon(doc, name));
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
  return b;
}

const canEdit = (editor: Editor) => structuralEditsAllowed(editor);

/** Write attrs onto the node at getPos() — one transaction. */
function setAttrs(editor: Editor, getPos: NodeViewRendererProps["getPos"], attrs: Record<string, unknown>): void {
  if (!canEdit(editor)) return;
  const pos = typeof getPos === "function" ? getPos() : undefined;
  if (typeof pos !== "number") return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

function selectThis(editor: Editor, getPos: NodeViewRendererProps["getPos"]): void {
  const pos = typeof getPos === "function" ? getPos() : undefined;
  if (typeof pos !== "number") return;
  try {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  } catch { /* the node moved */ }
}

/** Is this the native shell (Prism Client)? Its CSP has no frame-src beyond 'self'. */
const isNative = () => typeof window !== "undefined" && !!(window as Any).__PRISM_HOST__;
/** Can this shell frame `src`? The PWA's CSP allows EMBED_FRAME_ORIGINS; the native client only what its host advertises. */
function frameAllowedHere(src: string): boolean {
  if (!isNative()) return true;
  const allowed = (window as Any).__PRISM_HOST__?.frameOrigins;
  try { return Array.isArray(allowed) && allowed.includes(new URL(src).origin); } catch { return false; }
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

export function openLightbox(src: string, alt: string, caption?: string | null): void {
  const doc = document;
  const prev = doc.activeElement as HTMLElement | null;
  const overlay = h(doc, "div", "prism-lightbox", { role: "dialog", "aria-modal": "true", "aria-label": alt ? `Image: ${alt}` : "Image" });
  const img = h(doc, "img", "prism-lightbox-img", { alt });
  img.src = src;
  const close = h(doc, "button", "prism-lightbox-close", { type: "button", "aria-label": "Close image" });
  close.textContent = "×";
  overlay.append(img, close);
  if (caption) {
    const cap = h(doc, "p", "prism-lightbox-caption");
    cap.textContent = caption;
    overlay.append(cap);
  }
  const done = () => {
    overlay.remove();
    doc.removeEventListener("keydown", onKey, true);
    prev?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
    if (e.key === "Tab") { e.preventDefault(); close.focus(); }
  };
  overlay.addEventListener("click", (e) => { if (e.target !== img) done(); });
  doc.addEventListener("keydown", onKey, true);
  doc.body.append(overlay);
  close.focus();
}

// ── Image ────────────────────────────────────────────────────────────────────

const imageView: NodeViewRenderer = ({ node, editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  let current: PMNode = node;
  const dom = h(doc, "figure", "prism-image", { "data-type": "image-block" });
  const frame = h(doc, "div", "prism-image-frame");
  const img = h(doc, "img", "prism-image-img", { draggable: "false" });
  const left = h(doc, "span", "prism-image-handle", { "data-side": "left", "aria-hidden": "true" });
  const right = h(doc, "span", "prism-image-handle", { "data-side": "right", "aria-hidden": "true" });
  const bar = h(doc, "div", "prism-media-toolbar", { contenteditable: "false", role: "toolbar", "aria-label": "Image options" });
  const aligns: Array<[string, keyof typeof SVG, string]> = [["left", "alignLeft", "Align left"], ["center", "alignCenter", "Align center"], ["right", "alignRight", "Align right"], ["wide", "wide", "Full width"]];
  const alignButtons = aligns.map(([value, ic, label]) => {
    const b = button(doc, label, ic);
    b.dataset.align = value;
    b.addEventListener("click", () => setAttrs(editor, getPos, { align: value === "center" ? null : value, ...(value === "wide" ? { width: null } : {}) }));
    return b;
  });
  const captionBtn = button(doc, "Caption", "caption");
  const openBtn = button(doc, "View full screen", "expand");
  bar.append(...alignButtons, captionBtn, openBtn);
  const caption = h(doc, "figcaption", "prism-image-caption", { contenteditable: "false" });
  const input = h(doc, "input", "prism-image-caption-input", { type: "text", "aria-label": "Image caption", placeholder: "Write a caption…", maxlength: "500" });
  frame.append(img, left, right);
  dom.append(bar, frame, caption);

  let editingCaption = false;
  const paint = () => {
    const a = current.attrs;
    // Neutralise at render: a dangerous scheme never reaches the DOM; anything else
    // (relative, protocol-relative, cid:, blob:) is shown as the browser can.
    const src = isDangerousImageSrc(a.src) ? "" : String(a.src);
    if (img.getAttribute("src") !== src) { if (src) img.setAttribute("src", src); else img.removeAttribute("src"); }
    img.alt = a.alt ?? "";
    if (a.title) img.title = a.title; else img.removeAttribute("title");
    dom.dataset.align = a.align ?? "center";
    frame.style.width = a.width && a.align !== "wide" ? `${Math.round(Number(a.width))}px` : "";
    const editable = canEdit(editor);
    dom.toggleAttribute("data-editable", editable);
    for (const b of alignButtons) b.setAttribute("aria-pressed", String((a.align ?? "center") === b.dataset.align));
    captionBtn.hidden = !editable;
    for (const b of alignButtons) b.hidden = !editable;
    if (!editingCaption) {
      caption.replaceChildren();
      if (a.caption) caption.textContent = a.caption;
      caption.hidden = !a.caption;
    }
  };
  const editCaption = () => {
    if (!canEdit(editor)) return;
    editingCaption = true;
    input.value = current.attrs.caption ?? "";
    caption.hidden = false;
    caption.replaceChildren(input);
    input.focus();
  };
  const commitCaption = (save: boolean) => {
    if (!editingCaption) return;
    editingCaption = false;
    const value = input.value.trim().slice(0, 500) || null;
    if (save && value !== (current.attrs.caption ?? null)) setAttrs(editor, getPos, { caption: value });
    paint();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commitCaption(true); editor.commands.focus(); }
    if (e.key === "Escape") { e.preventDefault(); commitCaption(false); editor.commands.focus(); }
  });
  input.addEventListener("blur", () => commitCaption(true));
  captionBtn.addEventListener("click", editCaption);
  caption.addEventListener("click", editCaption);
  openBtn.addEventListener("click", () => openLightbox(img.currentSrc || img.src, img.alt, current.attrs.caption));
  img.addEventListener("click", (e) => {
    if (!canEdit(editor) || e.detail >= 2) openLightbox(img.currentSrc || img.src, img.alt, current.attrs.caption);
    else selectThis(editor, getPos);
  });

  // Drag-to-resize from either side (width in px, kept within the column).
  for (const handle of [left, right]) {
    handle.addEventListener("pointerdown", (e) => {
      if (!canEdit(editor)) return;
      e.preventDefault();
      e.stopPropagation();
      const side = handle.dataset.side;
      const startX = e.clientX;
      const startW = frame.getBoundingClientRect().width;
      const max = Math.max(120, (dom.getBoundingClientRect().width || startW));
      let width = startW;
      handle.setPointerCapture?.(e.pointerId);
      dom.classList.add("is-resizing");
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) * (side === "left" ? -1 : 1) * (current.attrs.align === "left" || current.attrs.align === "right" ? 1 : 2);
        width = Math.max(80, Math.min(max, startW + dx));
        frame.style.width = `${Math.round(width)}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        dom.classList.remove("is-resizing");
        setAttrs(editor, getPos, { width: Math.round(width), ...(current.attrs.align === "wide" ? { align: null } : {}) });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  paint();
  const onEditable = () => paint();
  editor.on("update", onEditable);
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      paint();
      return true;
    },
    selectNode() { dom.classList.add("is-selected"); },
    deselectNode() { dom.classList.remove("is-selected"); },
    stopEvent(e) {
      const t = e.target as Node | null;
      return !!t && (bar.contains(t) || caption.contains(t) || t === left || t === right);
    },
    ignoreMutation() { return true; },
    destroy() { editor.off("update", onEditable); },
  };
};

// ── Files (download card, PDF, audio, video) ────────────────────────────────

async function download(src: string, name: string): Promise<void> {
  // Own attachments go through the installed transport (cookie in the PWA, the
  // device bearer in the native client), so the download works in both.
  if (isOwnAttachment(src)) {
    const res = await serverFetch(src);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "download";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  // Anything else is an https link: opened in a new tab, never fetched with our credentials.
  const safe = safeAttachmentSrc(src);
  if (safe && !isOwnAttachment(safe)) window.open(safe, "_blank", "noopener,noreferrer");
}

const attachmentView: NodeViewRenderer = ({ node, editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  let current: PMNode = node;
  const dom = h(doc, "div", "prism-attachment", { "data-type": "attachment", contenteditable: "false" });
  const render = () => {
    const a = current.attrs;
    const src = safeAttachmentSrc(a.src) ?? "";
    // Players and the PDF frame are ONLY for our own access-checked attachments: `data-kind`
    // is independent of `data-src`, so an https "pdf"/"video" stays a plain link card.
    const own = isOwnAttachment(src);
    dom.dataset.kind = a.kind;
    dom.replaceChildren();
    const head = h(doc, "div", "prism-attachment-head");
    const glyph = h(doc, "span", "prism-attachment-icon");
    glyph.append(icon(doc, a.kind === "pdf" ? "pdf" : "file", 18));
    const meta = h(doc, "span", "prism-attachment-meta");
    const title = h(doc, "span", "prism-attachment-name");
    title.textContent = a.name || "Attachment";
    const sub = h(doc, "span", "prism-attachment-size");
    sub.textContent = [a.size != null ? formatBytes(a.size) : null, a.kind === "pdf" ? "PDF" : a.kind === "audio" ? "Audio" : a.kind === "video" ? "Video" : (a.mimeType && a.mimeType !== "application/octet-stream" ? a.mimeType : null)].filter(Boolean).join(" · ");
    meta.append(title, sub);
    const dl = button(doc, `Download ${a.name || "file"}`, "download", "prism-media-btn prism-attachment-download");
    const status = h(doc, "span", "prism-attachment-status", { role: "status" });
    dl.addEventListener("click", () => {
      status.textContent = "";
      download(src, a.name).catch(() => { status.textContent = "Couldn't download this file."; });
    });
    head.append(glyph, meta, status, dl);
    dom.append(head);
    if (!src || !own) return;
    if (a.kind === "audio") {
      const audio = h(doc, "audio", "prism-attachment-audio", { controls: "", preload: "metadata", "aria-label": a.name || "Audio" });
      audio.setAttribute("src", src);
      dom.append(audio);
    } else if (a.kind === "video") {
      const video = h(doc, "video", "prism-attachment-video", { controls: "", preload: "metadata", playsinline: "", "aria-label": a.name || "Video" });
      video.setAttribute("src", src);
      dom.append(video);
    } else if (a.kind === "pdf" && !isNative()) {
      // Same-origin frame (the server serves PDFs inline with frame-ancestors 'self').
      // The native client can't frame its server (CSP), so it keeps the download card.
      const frame = h(doc, "iframe", "prism-attachment-pdf", { title: `PDF preview: ${a.name || "document"}`, loading: "lazy", referrerpolicy: "no-referrer" });
      frame.setAttribute("src", src);
      dom.append(frame);
    }
  };
  render();
  dom.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, audio, video, iframe")) return;
    selectThis(editor, getPos);
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = JSON.stringify(next.attrs) !== JSON.stringify(current.attrs);
      current = next;
      if (changed) render(); // never re-create a playing <video> for an unrelated update
      return true;
    },
    selectNode() { dom.classList.add("is-selected"); },
    deselectNode() { dom.classList.remove("is-selected"); },
    stopEvent(e) {
      const t = e.target as HTMLElement | null;
      return !!t?.closest?.("button, audio, video, iframe");
    },
    ignoreMutation() { return true; },
  };
};

// ── Bookmark card ────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function bookmarkCard(doc: Document, attrs: Record<string, Any>, note?: string): HTMLElement {
  const url = safeWebUrl(attrs.url) ?? "";
  const card = h(doc, "a", "prism-bookmark", { href: url, target: "_blank", rel: "noopener noreferrer" });
  const text = h(doc, "span", "prism-bookmark-text");
  const title = h(doc, "span", "prism-bookmark-title");
  title.textContent = attrs.title || hostOf(url);
  text.append(title);
  if (attrs.description) {
    const d = h(doc, "span", "prism-bookmark-description");
    d.textContent = attrs.description;
    text.append(d);
  }
  const line = h(doc, "span", "prism-bookmark-url");
  const fav = ownOrProxiedSrc(attrs.favicon);
  if (fav) {
    const f = h(doc, "img", "prism-bookmark-favicon", { alt: "", width: "16", height: "16", loading: "lazy", referrerpolicy: "no-referrer" });
    f.src = fav;
    f.addEventListener("error", () => f.remove());
    line.append(f);
  } else line.append(icon(doc, "link", 14));
  const u = h(doc, "span");
  u.textContent = url;
  line.append(u);
  text.append(line);
  if (note) {
    const n = h(doc, "span", "prism-bookmark-note");
    n.textContent = note;
    text.append(n);
  }
  card.append(text);
  const image = ownOrProxiedSrc(attrs.image);
  if (image) {
    const wrap = h(doc, "span", "prism-bookmark-image");
    const img = h(doc, "img", undefined, { alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.src = image;
    img.addEventListener("error", () => wrap.remove());
    wrap.append(img);
    card.append(wrap);
  }
  return card;
}

const bookmarkView: NodeViewRenderer = ({ node, editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  let current: PMNode = node;
  const dom = h(doc, "div", "prism-bookmark-block", { "data-type": "bookmark", contenteditable: "false" });
  const render = () => dom.replaceChildren(bookmarkCard(doc, current.attrs));
  render();
  dom.addEventListener("click", (e) => {
    // In an editable doc, a plain click selects the block; ⌘/Ctrl-click (or any click when read-only) opens it.
    if (canEdit(editor) && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); selectThis(editor, getPos); }
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      render();
      return true;
    },
    selectNode() { dom.classList.add("is-selected"); },
    deselectNode() { dom.classList.remove("is-selected"); },
    stopEvent(e) { return e.type === "click" || e.type === "mousedown"; },
    ignoreMutation() { return true; },
  };
};

// ── Embed ────────────────────────────────────────────────────────────────────

const embedView: NodeViewRenderer = ({ node, editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  let current: PMNode = node;
  const dom = h(doc, "div", "prism-embed", { "data-type": "embed", contenteditable: "false" });
  let frame: HTMLIFrameElement | null = null;
  const render = () => {
    const url = safeWebUrl(current.attrs.url) ?? "";
    const target = embedFor(url);
    dom.replaceChildren();
    frame = null;
    if (!target || !isAllowedFrameSrc(target.src)) {
      // Unsupported or blocked: a bookmark card, never a blank frame.
      dom.dataset.fallback = "true";
      dom.append(bookmarkCard(doc, { url }, "This link can't be embedded, so it's shown as a bookmark."));
      return;
    }
    if (!frameAllowedHere(target.src)) {
      // The native client's CSP has no frame-src for players (pending review): a card, not a blank frame.
      dom.dataset.fallback = "true";
      dom.append(bookmarkCard(doc, { url, title: target.label }, `Open in ${target.label} — embeds aren't shown in this app yet.`));
      return;
    }
    delete dom.dataset.fallback;
    dom.dataset.provider = target.provider;
    const bar = h(doc, "div", "prism-embed-bar");
    const label = h(doc, "span", "prism-embed-label");
    label.textContent = target.label;
    const open = h(doc, "a", "prism-media-btn", { href: url, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open in ${target.label}`, title: `Open in ${target.label}` });
    open.append(icon(doc, "external", 15));
    bar.append(label, open);
    const box = h(doc, "div", "prism-embed-frame");
    const height = current.attrs.height ?? target.height;
    if (height) box.style.height = `${height}px`;
    else box.style.aspectRatio = "16 / 9";
    frame = h(doc, "iframe", undefined, {
      title: `${target.label} embed`,
      sandbox: EMBED_SANDBOX,
      allow: target.allow,
      referrerpolicy: "strict-origin-when-cross-origin",
      loading: "lazy",
      allowfullscreen: "",
    });
    frame.setAttribute("src", target.src);
    box.append(frame);
    const grip = h(doc, "div", "prism-embed-resize", { role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize embed", tabindex: "0" });
    grip.hidden = !canEdit(editor);
    grip.addEventListener("pointerdown", (e) => {
      if (!canEdit(editor)) return;
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = box.getBoundingClientRect().height;
      let next = startH;
      grip.setPointerCapture?.(e.pointerId);
      dom.classList.add("is-resizing");
      const move = (ev: PointerEvent) => {
        next = Math.max(120, Math.min(1600, startH + ev.clientY - startY));
        box.style.aspectRatio = "";
        box.style.height = `${Math.round(next)}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        dom.classList.remove("is-resizing");
        setAttrs(editor, getPos, { height: Math.round(next) });
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    grip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const cur = box.getBoundingClientRect().height;
      setAttrs(editor, getPos, { height: Math.max(120, Math.min(1600, Math.round(cur + (e.key === "ArrowDown" ? 40 : -40)))) });
    });
    dom.append(bar, box, grip);
  };
  render();
  dom.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a, .prism-embed-resize")) return;
    selectThis(editor, getPos);
  });
  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const urlChanged = next.attrs.url !== current.attrs.url;
      const heightChanged = next.attrs.height !== current.attrs.height;
      current = next;
      if (urlChanged) render(); // never reload a playing frame for a resize
      else if (heightChanged && frame) {
        const box = frame.parentElement as HTMLElement;
        box.style.aspectRatio = "";
        box.style.height = `${next.attrs.height}px`;
      }
      return true;
    },
    selectNode() { dom.classList.add("is-selected"); },
    deselectNode() { dom.classList.remove("is-selected"); },
    stopEvent(e) {
      const t = e.target as HTMLElement | null;
      return !!t?.closest?.("a, iframe, .prism-embed-resize");
    },
    ignoreMutation() { return true; },
  };
};

// ── Table of contents ────────────────────────────────────────────────────────

interface Heading { level: number; text: string; pos: number }

export function collectHeadings(doc: PMNode): Heading[] {
  const out: Heading[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === "heading") {
      const text = n.textContent.trim();
      if (text) out.push({ level: Number(n.attrs.level) || 1, text, pos });
      return false;
    }
    return n.type.name !== "tableOfContents";
  });
  return out;
}

const tocView: NodeViewRenderer = ({ editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  const dom = h(doc, "nav", "prism-toc", { "data-type": "toc", "aria-label": "Table of contents", contenteditable: "false" });
  let lastKey = "";
  const render = () => {
    const heads = collectHeadings(view.state.doc);
    const key = heads.map((x) => `${x.level}:${x.pos}:${x.text}`).join("\n");
    if (key === lastKey && dom.childElementCount) return;
    lastKey = key;
    dom.replaceChildren();
    if (!heads.length) {
      const empty = h(doc, "p", "prism-toc-empty");
      empty.textContent = "Add headings to build a table of contents.";
      dom.append(empty);
      return;
    }
    const min = Math.min(...heads.map((x) => x.level));
    const list = h(doc, "ol", "prism-toc-list");
    for (const head of heads) {
      const li = h(doc, "li");
      li.style.paddingInlineStart = `${(head.level - min) * 16}px`;
      const b = h(doc, "button", "prism-toc-item", { type: "button" });
      b.textContent = head.text;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        try {
          const at = view.nodeDOM(head.pos) as HTMLElement | null;
          at?.scrollIntoView({ block: "start", behavior: "smooth" });
          const sel = editor.state.doc.resolve(Math.min(head.pos + 1, editor.state.doc.content.size));
          if (editor.isEditable) editor.chain().setTextSelection(sel.pos).run();
        } catch { /* heading moved; the next update re-renders */ }
      });
      li.append(b);
      list.append(li);
    }
    dom.append(list);
  };
  render();
  const onUpdate = () => render();
  editor.on("update", onUpdate);
  dom.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    selectThis(editor, getPos);
  });
  return {
    dom,
    update(next) { return next.type.name === "tableOfContents"; },
    selectNode() { dom.classList.add("is-selected"); },
    deselectNode() { dom.classList.remove("is-selected"); },
    stopEvent(e) { return !!(e.target as HTMLElement)?.closest?.("button"); },
    ignoreMutation() { return true; },
    destroy() { editor.off("update", onUpdate); },
  };
};

// ── Code block: language picker, copy, wrap ──────────────────────────────────

const LANGUAGE_LABELS: Record<string, string> = {
  javascript: "JavaScript", typescript: "TypeScript", python: "Python", bash: "Bash", shell: "Shell", json: "JSON", xml: "HTML/XML",
  css: "CSS", scss: "SCSS", markdown: "Markdown", sql: "SQL", go: "Go", rust: "Rust", java: "Java", kotlin: "Kotlin", swift: "Swift",
  c: "C", cpp: "C++", csharp: "C#", php: "PHP", ruby: "Ruby", yaml: "YAML", ini: "INI/TOML", diff: "Diff", lua: "Lua", r: "R",
  perl: "Perl", makefile: "Makefile", graphql: "GraphQL", objectivec: "Objective-C", plaintext: "Plain text", vbnet: "VB.NET", wasm: "WebAssembly",
};
export const languageLabel = (lang: string | null | undefined) => (lang ? LANGUAGE_LABELS[lang] ?? lang : "Plain text");

function openLanguagePicker(doc: Document, anchor: HTMLElement, current: string | null, onPick: (lang: string | null) => void): void {
  const langs = codeLanguages();
  const pop = h(doc, "div", "prism-code-picker editor-menu", { role: "dialog", "aria-label": "Code language" });
  const search = h(doc, "input", "prism-code-picker-search", { type: "search", placeholder: "Search languages", "aria-label": "Search languages", autocomplete: "off" });
  const list = h(doc, "div", "prism-code-picker-list", { role: "listbox", "aria-label": "Languages" });
  pop.append(search, list);
  let items: Array<string | null> = [];
  let active = 0;
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    items = [null, ...langs].filter((l) => !q || languageLabel(l).toLowerCase().includes(q) || (l ?? "plain text").includes(q));
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((l, i) => {
      const o = h(doc, "div", "prism-code-picker-option editor-menu-item", { role: "option", "aria-selected": String(i === active) });
      o.textContent = languageLabel(l);
      if (l === current) o.dataset.current = "true";
      o.addEventListener("mousedown", (e) => e.preventDefault());
      o.addEventListener("click", () => { finish(); onPick(l); });
      return o;
    }));
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const r = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 300)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
  pop.style.zIndex = "75";
  const finish = () => {
    pop.remove();
    doc.removeEventListener("mousedown", outside, true);
    anchor.focus();
  };
  const outside = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) finish(); };
  search.addEventListener("input", () => { active = 0; paint(); });
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); if (items.length) { finish(); onPick(items[active] ?? null); } }
    else if (e.key === "Escape") { e.preventDefault(); finish(); }
  });
  doc.addEventListener("mousedown", outside, true);
  doc.body.append(pop);
  paint();
  search.focus();
}

/** Wrap is per-viewer view state; carried across node-view re-creation (same node object) and edits (update). */
const wrapState = new WeakMap<PMNode, boolean>();

const codeBlockView: NodeViewRenderer = ({ node, editor, getPos, view }) => {
  const doc = (view.dom as HTMLElement).ownerDocument;
  let current: PMNode = node;
  const dom = h(doc, "div", "prism-code-block");
  const bar = h(doc, "div", "prism-code-bar", { contenteditable: "false" });
  const lang = h(doc, "button", "prism-code-lang", { type: "button", "aria-haspopup": "dialog" });
  const langText = h(doc, "span");
  lang.append(langText, icon(doc, "chevron", 14));
  lang.addEventListener("mousedown", (e) => e.preventDefault());
  const actions = h(doc, "span", "prism-code-actions");
  const wrapBtn = button(doc, "Wrap lines", "wrap", "prism-media-btn prism-code-action");
  const copyBtn = button(doc, "Copy code", "copy", "prism-media-btn prism-code-action");
  const copied = h(doc, "span", "prism-code-copied", { role: "status" });
  actions.append(copied, wrapBtn, copyBtn);
  bar.append(lang, actions);
  const pre = h(doc, "pre");
  const code = h(doc, "code");
  pre.append(code);
  dom.append(bar, pre);
  let wrap = wrapState.get(node) ?? false;
  const paint = () => {
    wrapState.set(current, wrap);
    const l = current.attrs.language as string | null;
    langText.textContent = languageLabel(l);
    // Only touch contentDOM attributes when they change: any attribute write on it
    // (even the same value) is a mutation ProseMirror would answer with a redraw.
    const cls = l ? `language-${l}` : "";
    if (code.className !== cls) code.className = cls;
    lang.setAttribute("aria-label", `Code language: ${languageLabel(l)}${canEdit(editor) ? ". Change language" : ""}`);
    lang.disabled = !canEdit(editor);
    wrapBtn.setAttribute("aria-pressed", String(wrap));
    dom.toggleAttribute("data-wrap", wrap);
  };
  lang.addEventListener("click", () => {
    if (!canEdit(editor)) return;
    openLanguagePicker(doc, lang, current.attrs.language ?? null, (l) => setAttrs(editor, getPos, { language: l }));
  });
  wrapBtn.addEventListener("click", () => { wrap = !wrap; paint(); });
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(current.textContent);
      copied.textContent = "Copied";
    } catch {
      copied.textContent = "Copy failed";
    }
    setTimeout(() => { copied.textContent = ""; }, 1600);
  });
  paint();
  const onUpdate = () => { lang.disabled = !canEdit(editor); };
  editor.on("update", onUpdate);
  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== current.type) return false;
      current = next;
      paint();
      return true;
    },
    stopEvent(e) { return bar.contains(e.target as Node); },
    ignoreMutation(m) {
      if ((m as { type: string }).type === "selection") return false;
      const rec = m as MutationRecord;
      if (rec.type === "attributes" && rec.target === code) return true; // our own class write
      return !code.contains(rec.target);
    },
    destroy() { editor.off("update", onUpdate); },
  };
};

let registered = false;
/** Idempotent: register the browser views with the shared schema. */
export function registerMediaViews(): void {
  if (registered || typeof document === "undefined") return;
  registered = true;
  registerBlockViews({
    image: imageView,
    attachment: attachmentView,
    embed: embedView,
    bookmark: bookmarkView,
    tableOfContents: tocView,
    codeBlock: codeBlockView,
  });
}
registerMediaViews();
