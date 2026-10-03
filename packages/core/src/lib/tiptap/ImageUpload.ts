import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { structuralEditsAllowed } from "./blockCommands";
import { attachmentKind, MAX_FILE_BYTES } from "../media/attachments";

/**
 * Paste / drop / pick images into the document through an OPTIONAL host
 * uploader (`VaultClient.uploadAttachment`). With no uploader the extension is
 * inert: pasted/dropped files fall through to ProseMirror's default handling and
 * the UI only offers "Image from URL".
 *
 * Flow: the file is read as nothing (no data: URLs land in stored HTML); a
 * transient `data-uploading` image is NOT inserted either — the image node is
 * inserted only once the host returns a URL, at the position the paste/drop
 * targeted (mapped through edits made meanwhile).
 */
export interface UploadedImage { src: string; alt?: string; title?: string }
export type ImageUploader = (file: File) => Promise<UploadedImage>;
/** A stored non-image file (PDF, audio, video, anything else the server accepts). */
export interface UploadedFile { src: string; name: string; size: number; mimeType: string }
export type FileUploader = (file: File) => Promise<UploadedFile>;

export interface ImageUploadOptions {
  upload?: ImageUploader;
  /** Optional: store non-image files and insert a file/PDF/audio/video block. */
  uploadFile?: FileUploader;
  /** Largest non-image file the client will try to send (bytes). */
  maxFileBytes?: number;
  /** Called with a short, user-facing message when an upload fails or is refused. */
  onError?: (message: string) => void;
  /** Largest file the client will try to send (bytes). The server enforces its own cap. */
  maxBytes: number;
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

const key = new PluginKey<{ pending: Array<{ id: number; pos: number }> }>("imageUpload");
let seq = 0;

/** Upload `files` (images only) and insert each at `pos` (default: the selection). */
export async function uploadImages(editor: Editor, files: File[], pos?: number): Promise<number> {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "imageUpload");
  const options = ext?.options as ImageUploadOptions | undefined;
  const upload = options?.upload;
  if (!upload) return 0;
  const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
  if (images.length < files.length) options?.onError?.("Only PNG, JPEG, GIF, WebP and AVIF images can be added here.");
  let inserted = 0;
  for (const file of images) {
    if (file.size > options!.maxBytes) {
      options?.onError?.(`${file.name} is larger than ${Math.round(options!.maxBytes / 1_048_576)} MB.`);
      continue;
    }
    // Track the target through concurrent edits (incl. remote collab updates).
    const id = ++seq;
    const at = pos ?? editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.setMeta(key, { add: { id, pos: at } }));
    try {
      const result = await upload(file);
      if (editor.isDestroyed) return inserted;
      // The user may have lost edit access, entered suggest/comment-only mode, or
      // the editor became read-only while the upload ran: insert nothing then.
      if (!structuralEditsAllowed(editor)) {
        editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
        options?.onError?.(`${file.name} was uploaded but not added: this document is no longer editable here.`);
        continue;
      }
      const tracked = key.getState(editor.state)?.pending.find((p) => p.id === id);
      const target = tracked?.pos ?? editor.state.selection.from;
      editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
      editor.chain().insertContentAt(target, { type: "image", attrs: { src: result.src, alt: result.alt ?? file.name.replace(/\.[^.]+$/, ""), title: result.title ?? null } }).run();
      inserted++;
    } catch {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
      options?.onError?.(`Couldn't upload ${file.name}. Nothing was added.`);
    }
  }
  return inserted;
}

/** Upload non-image `files` and insert one file block each at `pos` (default: the selection). */
export async function uploadFiles(editor: Editor, files: File[], pos?: number): Promise<number> {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "imageUpload");
  const options = ext?.options as ImageUploadOptions | undefined;
  const upload = options?.uploadFile;
  if (!upload) return 0;
  const max = options?.maxFileBytes ?? MAX_FILE_BYTES;
  let inserted = 0;
  for (const file of files) {
    if (file.size > max) {
      options?.onError?.(`${file.name} is larger than ${Math.round(max / 1_048_576)} MB.`);
      continue;
    }
    if (/\.(svg|html?|xhtml|xml|js|mjs|cjs|css)$/i.test(file.name) || file.type === "image/svg+xml" || file.type === "text/html") {
      options?.onError?.(`${file.name} can't be attached: web pages, scripts and SVG files aren't allowed.`);
      continue;
    }
    const id = ++seq;
    const at = pos ?? editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.setMeta(key, { add: { id, pos: at } }));
    try {
      const result = await upload(file);
      if (editor.isDestroyed) return inserted;
      if (!structuralEditsAllowed(editor)) {
        editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
        options?.onError?.(`${file.name} was uploaded but not added: this document is no longer editable here.`);
        continue;
      }
      const tracked = key.getState(editor.state)?.pending.find((p) => p.id === id);
      const target = tracked?.pos ?? editor.state.selection.from;
      editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
      editor.chain().insertContentAt(target, {
        type: "attachment",
        attrs: { src: result.src, name: result.name || file.name, size: result.size ?? file.size, mimeType: result.mimeType, kind: attachmentKind(result.mimeType) },
      }).run();
      inserted++;
    } catch (e) {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, { remove: id }));
      const reason = (e as { userMessage?: string })?.userMessage;
      options?.onError?.(reason ? `Couldn't upload ${file.name}: ${reason}` : `Couldn't upload ${file.name}. Nothing was added.`);
    }
  }
  return inserted;
}

export function canUploadFiles(editor: Editor | null): boolean {
  const ext = editor?.extensionManager.extensions.find((e) => e.name === "imageUpload");
  return !!(ext?.options as ImageUploadOptions | undefined)?.uploadFile;
}

/** Open the file picker (optionally filtered, e.g. "application/pdf" or "audio/*") and attach the files at the selection. */
export function pickAndUploadFiles(editor: Editor, accept?: string): void {
  const input = document.createElement("input");
  input.type = "file";
  if (accept) input.accept = accept;
  input.multiple = true;
  input.style.display = "none";
  const pos = editor.state.selection.from;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) void uploadFiles(editor, files, pos);
  });
  document.body.appendChild(input);
  input.click();
}

export function canUploadImages(editor: Editor | null): boolean {
  const ext = editor?.extensionManager.extensions.find((e) => e.name === "imageUpload");
  return !!(ext?.options as ImageUploadOptions | undefined)?.upload;
}

/** Open the system file picker and upload the chosen images at the selection. */
export function pickAndUploadImages(editor: Editor): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_TYPES.join(",");
  input.multiple = true;
  input.style.display = "none";
  const pos = editor.state.selection.from;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) void uploadImages(editor, files, pos);
  });
  document.body.appendChild(input);
  input.click();
}

export const ImageUpload = Extension.create<ImageUploadOptions>({
  name: "imageUpload",
  addOptions() {
    return { upload: undefined, uploadFile: undefined, onError: undefined, maxBytes: 10 * 1024 * 1024, maxFileBytes: MAX_FILE_BYTES };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const enabled = () => !!this.options.upload && structuralEditsAllowed(editor);
    const filesEnabled = () => !!this.options.uploadFile && structuralEditsAllowed(editor);
    const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    const otherFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => !f.type.startsWith("image/"));
    return [
      new Plugin({
        key,
        state: {
          init: () => ({ pending: [] as Array<{ id: number; pos: number }> }),
          apply(tr, value) {
            const meta = tr.getMeta(key) as { add?: { id: number; pos: number }; remove?: number } | undefined;
            let pending = value.pending.map((p) => ({ id: p.id, pos: tr.mapping.map(p.pos) }));
            if (meta?.add) pending = [...pending, meta.add];
            if (meta?.remove) pending = pending.filter((p) => p.id !== meta.remove);
            return { pending };
          },
        },
        props: {
          handlePaste: (_view, event) => {
            const list = event.clipboardData?.files;
            const images = enabled() ? imageFiles(list) : [];
            const others = filesEnabled() ? otherFiles(list) : [];
            if (!images.length && !others.length) return false;
            event.preventDefault();
            void (async () => {
              if (images.length) await uploadImages(editor, images);
              if (others.length) await uploadFiles(editor, others);
            })();
            return true;
          },
          handleDrop: (view, event) => {
            const list = (event as DragEvent).dataTransfer?.files;
            const images = enabled() ? imageFiles(list) : [];
            const others = filesEnabled() ? otherFiles(list) : [];
            if (!images.length && !others.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
            void (async () => {
              if (images.length) await uploadImages(editor, images, at?.pos);
              if (others.length) await uploadFiles(editor, others, at?.pos);
            })();
            return true;
          },
        },
      }),
    ];
  },
});
