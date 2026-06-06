import type { Note } from "../../lib/types";

export interface RendererProps {
  note: Note;
  onSave: (content: string) => void;
  onMetadataChange: (metadata: Record<string, unknown>) => void;
}
