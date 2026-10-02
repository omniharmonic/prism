import { isNative, serverFetch, gatewayOrigin } from "../transport";
import { installExternalImageProxy } from "../native/externalImages";
import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicationPreviewProps } from "@prism/core";
import { managementRequest } from "../collab/grant";
import { getTemplate } from "./templates/registry";
import type {
  PublicationManifest,
  PubNote,
  PubGraph,
  PubMapFeature,
} from "./templates/types";
interface Preview {
  manifest: PublicationManifest;
  note: PubNote | null;
  graph: PubGraph;
  mapFeatures: PubMapFeature[];
  expired: boolean;
}
/** Same template and sanitization as the reader, with an authenticated data
 * source and no public token, navigation URL, or browser-history mutation. */
export default function PresentationPreview({
  slug,
  draftRevision,
  onClose,
}: PublicationPreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewportWidth, setViewportWidth] = useState(390);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [frameBody, setFrameBody] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!frameBody || !isNative) return;
    return installExternalImageProxy({
      fetch: serverFetch,
      apiOrigin: gatewayOrigin,
      root: frameBody.ownerDocument,
    });
  }, [frameBody]);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setData(null);
    const query = new URLSearchParams({ draftRevision: String(draftRevision) });
    if (pageId) query.set("noteId", pageId);
    managementRequest(
      "/acl",
      `/publications/${encodeURIComponent(slug)}/presentation/preview?${query}`,
    )
      .then((r) => r.json())
      .then((value: Preview) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive)
          setError(e instanceof Error ? e.message : "Preview unavailable.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, draftRevision, pageId, retry]);
  // An isolated viewport makes the actual template's media queries work at both
  // phone and desktop sizes. No credentials or app bootstrap are copied in.
  const initFrame = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.documentElement.className = document.documentElement.className;
    for (const attr of ["data-theme", "data-color-mode"]) {
      const value = document.documentElement.getAttribute(attr);
      if (value) doc.documentElement.setAttribute(attr, value);
    }
    for (const node of document.querySelectorAll(
      'link[rel="stylesheet"],style',
    ))
      doc.head.appendChild(node.cloneNode(true));
    doc.body.style.margin = "0";
    setFrameBody(doc.body);
  };
  const Template = data ? getTemplate(data.manifest.template) : null;
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label="Private publication preview"
      className="m-auto h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-none rounded-xl border border-[var(--glass-border)] bg-[var(--bg-base)] p-0 text-[var(--text-primary)] backdrop:bg-black/50"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--glass-border)] p-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              Private preview · draft {draftRevision}
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Saved appearance with current eligible content.{" "}
              {data?.expired
                ? "The live site is expired."
                : "Nothing is published by previewing."}
            </p>
          </div>
          <button
            className="min-h-11 rounded-lg border border-[var(--glass-border)] px-3 text-sm"
            aria-pressed={phone}
            onClick={() => setPhone((p) => !p)}
          >
            {phone ? "Desktop preview" : "Phone preview"}
          </button>
          <button
            autoFocus
            className="min-h-11 rounded-lg border border-[var(--glass-border)] px-3 text-sm"
            onClick={onClose}
          >
            Close preview
          </button>
        </header>
        {error && (
          <div role="alert" className="p-4 text-sm">
            {error}
            <button
              className="ml-3 min-h-11 underline"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry preview
            </button>
          </div>
        )}
        {loading && (
          <p role="status" className="p-4 text-sm">
            Loading private preview…
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--glass)] p-2">
          <iframe
            ref={frame}
            // WebKit requires allow-scripts even for React listeners installed by
            // this trusted parent. The document CSP still forbids all scripts
            // and inline handlers originating inside the preview itself.
            sandbox="allow-same-origin allow-scripts"
            title="Publication preview viewport"
            onLoad={initFrame}
            srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>`}
            style={{
              display: "block",
              width: phone ? 390 : "100%",
              maxWidth: "100%",
              height: "100%",
              margin: "auto",
              border: 0,
              borderRadius: 8,
            }}
          />
          {frameBody &&
            data &&
            Template &&
            createPortal(
              <Suspense fallback={<p>Loading site layout…</p>}>
                <Template
                  viewportWidth={viewportWidth}
                  manifest={data.manifest}
                  slug={slug}
                  activeId={data.note?.id ?? null}
                  note={data.note}
                  noteLoading={false}
                  onNavigate={setPageId}
                  graph={data.graph}
                  mapFeatures={data.mapFeatures}
                  onRequestMap={() => {}}
                />
              </Suspense>,
              frameBody,
            )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
