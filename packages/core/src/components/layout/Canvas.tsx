import { Suspense, useCallback, useMemo } from "react";
import { Compass } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useNote, useUpdateNote } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { getRenderer } from "../renderers/Registry";
import { useCollabDocumentSeam } from "../../data/CollabDocumentContext";
import { TagView } from "../navigation/TagView";
import { TabBar } from "./TabBar";
import { RendererBoundary } from "./RendererBoundary";
import { Skeleton } from "../ui/Skeleton";
import type { Note } from "../../lib/types";

export function Canvas() {
  const { openTabs, activeTabId } = useUIStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  // Tag views are a special virtual tab type
  const isTagView = activeTab?.noteId.startsWith("tag:");

  // Virtual notes (e.g., matrix:room_id, messages-dashboard, calendar-dashboard) don't come from Parachute
  const VIRTUAL_TAB_IDS = new Set(["messages-dashboard", "calendar-dashboard", "vault-messages", "agent-activity"]);
  const isVirtual = activeTab ? (
    (activeTab.noteId.includes(":") && !activeTab.noteId.match(/^\d/)) ||
    VIRTUAL_TAB_IDS.has(activeTab.noteId)
  ) : false;
  const parachuteNoteId = isVirtual ? null : (activeTab?.noteId ?? null);

  const { data: note, isLoading } = useNote(parachuteNoteId);
  const updateNote = useUpdateNote();

  // For virtual notes, construct a synthetic Note object
  const effectiveNote: Note | null = useMemo(() => {
    if (note) return note;
    if (isVirtual && activeTab) {
      return {
        id: activeTab.noteId,
        content: "",
        path: activeTab.title,
        metadata: {
          type: activeTab.type,
          matrix_room_id: activeTab.noteId.replace("matrix:", ""),
        },
        createdAt: new Date().toISOString(),
        updatedAt: null,
        tags: null,
      };
    }
    return null;
  }, [note, isVirtual, activeTab]);

  const handleSave = useCallback(
    (content: string) => {
      if (!note || isVirtual) return;
      updateNote.mutate({ id: note.id, content });
    },
    [note, isVirtual, updateNote],
  );

  const handleMetadataChange = useCallback(
    (metadata: Record<string, unknown>) => {
      if (!note || isVirtual) return;
      updateNote.mutate({ id: note.id, metadata });
    },
    [note, isVirtual, updateNote],
  );

  // For virtual tabs, use the tab type directly (inferContentType doesn't know virtual types)
  const contentType = isVirtual ? (activeTab?.type ?? null) : (effectiveNote ? inferContentType(effectiveNote) : (activeTab?.type ?? null));
  const Renderer = contentType ? getRenderer(contentType) : null;

  // Collab-capable notes render in the live collaborative editor so every session
  // (this one, another browser, a phone) sees edits in real time with no refresh.
  // The seam's CollabDocument auto-detects the kind (document → prose, code →
  // CodeMirror, spreadsheet → grid, canvas → Excalidraw). The hook is called
  // unconditionally; shells that provide collab return true for these kinds, the
  // default (offline shells) returns false → plain autosave editor.
  const COLLAB_TYPES = new Set(["document", "code", "spreadsheet", "canvas"]);
  const collab = useCollabDocumentSeam();
  const collabDocId =
    !isVirtual && effectiveNote && contentType && COLLAB_TYPES.has(contentType) ? effectiveNote.id : "";
  const isLiveDoc = collab.useLiveCollab(collabDocId) && collabDocId !== "";

  return (
    <div className="flex flex-col h-full">
      <TabBar />

      <div className="flex-1 overflow-auto">
        {!activeTab ? (
          <EmptyState />
        ) : isTagView ? (
          <TagView tag={activeTab.noteId.replace("tag:", "")} />
        ) : !isVirtual && isLoading ? (
          <LoadingSkeleton />
        ) : effectiveNote && isLiveDoc ? (
          // Keyed by note id so a crash on one note clears when you switch tabs.
          <RendererBoundary key={effectiveNote.id}>
            <collab.CollabDocument noteId={effectiveNote.id} note={effectiveNote} />
          </RendererBoundary>
        ) : effectiveNote && Renderer ? (
          <RendererBoundary key={effectiveNote.id}>
            <Suspense fallback={<LoadingSkeleton />}>
              <Renderer
                note={effectiveNote}
                onSave={handleSave}
                onMetadataChange={handleMetadataChange}
              />
            </Suspense>
          </RendererBoundary>
        ) : (
          <div className="text-center pt-20" style={{ color: "var(--text-muted)" }}>
            Note not found.
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4" style={{ background: "var(--bg-base)" }}>
      <div
        className="flex items-center justify-center"
        style={{
          width: 56,
          height: 56,
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-hover)",
          color: "var(--text-muted)",
        }}
      >
        <Compass size={26} strokeWidth={1.5} />
      </div>
      <div className="flex flex-col items-center" style={{ gap: 6 }}>
        <p style={{ fontSize: "var(--text-xl)", fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
          Open a document
        </p>
        <p className="flex items-center" style={{ gap: 6, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
          Pick one from the sidebar, or press <kbd>&#8984;K</kbd> to search
        </p>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 max-w-2xl mx-auto pt-12 px-6">
      <Skeleton width="60%" height={28} />
      <Skeleton width="100%" height={16} />
      <Skeleton width="90%" height={16} />
      <Skeleton width="75%" height={16} />
      <Skeleton width="85%" height={16} />
    </div>
  );
}
