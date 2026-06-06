import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Link as LinkIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { Spinner } from "../ui/Spinner";
import type { Note } from "../../lib/types";

interface LinksPanelProps {
  noteId: string;
}

interface VaultLink {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export function LinksPanel({ noteId }: LinksPanelProps) {
  const openTab = useUIStore((s) => s.openTab);

  const { data: links, isLoading, isError } = useQuery({
    queryKey: ["vault", "links", noteId],
    queryFn: async () => {
      // Get both outbound and inbound links
      const outbound = await invoke<VaultLink[]>("vault_get_links", {
        noteId,
        relationship: null,
      }).catch(() => [] as VaultLink[]);

      return outbound;
    },
    enabled: !!noteId,
  });

  // For each linked note, we need to resolve the target
  const linkedNoteIds = (links || []).map((l) =>
    l.sourceId === noteId ? l.targetId : l.sourceId
  );

  const { data: linkedNotes } = useQuery({
    queryKey: ["vault", "linked-notes", linkedNoteIds.join(",")],
    queryFn: async () => {
      const notes: Note[] = [];
      for (const id of linkedNoteIds.slice(0, 20)) {
        try {
          const note = await invoke<Note>("vault_get_note", { id });
          notes.push(note);
        } catch { /* skip missing */ }
      }
      return notes;
    },
    enabled: linkedNoteIds.length > 0,
  });

  const handleOpenNote = (note: Note) => {
    const type = inferContentType(note);
    const title = note.path?.split("/").pop() || note.id;
    openTab(note.id, title, type);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={16} />
      </div>
    );
  }

  if (isError || !links || links.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          No links to other notes.
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Links are created when notes reference each other via [[wikilinks]] in the vault.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        {links.length} connection{links.length !== 1 ? "s" : ""}
      </div>

      {links.map((link, i) => {
        const targetId = link.sourceId === noteId ? link.targetId : link.sourceId;
        const targetNote = (linkedNotes || []).find((n) => n.id === targetId);
        const title = targetNote?.path?.split("/").pop() || targetId;

        return (
          <button
            key={i}
            onClick={() => targetNote && handleOpenNote(targetNote)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-primary)" }}
          >
            <LinkIcon size={13} style={{ color: "var(--text-muted)" }} />
            <span className="flex-1 truncate">{title}</span>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {link.relationship}
            </span>
            <ArrowRight size={11} style={{ color: "var(--text-muted)" }} />
          </button>
        );
      })}
    </div>
  );
}
