import type { Note } from "../../lib/types";

export interface RendererProps {
  note: Note;
  /**
   * Persist edited content. Optional: omitted on the read-only public/shared
   * path (see `readOnly`). Editing callers (desktop, web owner) always pass it.
   */
  onSave?: (content: string) => void;
  /** Persist a metadata change. Optional for the same reason as `onSave`. */
  onMetadataChange?: (metadata: Record<string, unknown>) => void;
  /**
   * Render without any editing affordances or autosave — used by the published
   * Wiki and other anonymous read-only surfaces. Defaults to false (editable).
   */
  readOnly?: boolean;
}
