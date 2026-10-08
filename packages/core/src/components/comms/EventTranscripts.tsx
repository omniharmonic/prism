import { useTranscriptReviewClient } from "../../data/TranscriptReviewClientContext";
import { TranscriptReviewPanel } from "./TranscriptReviewPanel";
import { transcriptNoteId } from "./transcriptReviewReceipt";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";

/** Only stored relationships are navigation targets. Search hits are not confirmed links. */
type Props = {
  noteId?: string;
  eventId?: string;
  onOpen: (id: string, title: string) => void;
};
export function EventTranscripts(props: Props) {
  const review = useTranscriptReviewClient();
  const audience = useAgentChatStore((s) => s.scope);
  if (review && props.noteId && !transcriptNoteId(props.noteId))
    return (
      <p role="alert" className="text-sm">
        This meeting needs its saved vault record before transcripts can be
        reviewed.
      </p>
    );
  return review && props.noteId ? (
    <TranscriptReviewPanel
      key={JSON.stringify([
        review.scope(),
        audience,
        props.noteId,
        props.eventId,
      ])}
      client={review}
      noteId={props.noteId}
      eventId={props.eventId}
      onOpen={props.onOpen}
    />
  ) : (
    <StoredEventTranscripts {...props} />
  );
}
function StoredEventTranscripts({ noteId, eventId, onOpen }: Props) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const result = useQuery({
    queryKey: ["calendar", "transcript-links", scope, noteId, eventId],
    enabled: !!noteId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const meeting = await client.getNote(noteId!);
      if (
        meeting.id !== noteId ||
        (eventId &&
          (meeting.metadata?.calendarEventId || meeting.id) !== eventId)
      )
        throw new Error("Meeting identity changed");
      const metadata = meeting.metadata ?? {};
      const links = await client.getLinks(meeting.id, "has-transcript");
      const ids = [
        ...new Set(
          [
            ...(typeof metadata.transcriptNoteId === "string"
              ? [metadata.transcriptNoteId]
              : []),
            ...(Array.isArray(metadata.transcriptNoteIds)
              ? metadata.transcriptNoteIds.filter(
                  (id): id is string => typeof id === "string",
                )
              : []),
            ...links
              .filter((link) => link.sourceId === meeting.id)
              .map((link) => link.targetId),
          ].filter(Boolean),
        ),
      ];
      const notes = await Promise.allSettled(
        ids.map((id) => client.getNote(id)),
      );
      return {
        notes: notes.flatMap((n) =>
          n.status === "fulfilled" ? [n.value] : [],
        ),
        unavailable: notes.some((n) => n.status === "rejected"),
      };
    },
  });
  return (
    <section
      aria-label="Meeting transcripts"
      className="space-y-2 rounded-xl border p-3"
      style={{ borderColor: "var(--glass-border)" }}
    >
      <h4 className="text-xs font-medium">Transcripts</h4>
      {!noteId ? (
        <p className="text-xs">
          Refresh the calendar to load this meeting's record.
        </p>
      ) : result.isFetching ? (
        <p role="status" className="text-xs">
          Checking linked transcripts…
        </p>
      ) : result.isError ? (
        <p role="alert" className="text-xs">
          Couldn't check this meeting's transcripts.{" "}
          <button
            className="focus-ring min-h-control underline"
            onClick={() => void result.refetch()}
          >
            Try again
          </button>
        </p>
      ) : (
        <>
          {result.data?.notes.map((note) => (
            <button
              key={note.id}
              onClick={() =>
                onOpen(note.id, note.path?.split("/").pop() || "Transcript")
              }
              className="interactive focus-ring flex w-full min-h-control min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
            >
              <FileText size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {note.path?.split("/").pop() || "Transcript"}
              </span>
            </button>
          ))}
          {result.data?.unavailable && (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Some linked transcripts are unavailable or you don't have access.
            </p>
          )}
          {result.data &&
            !result.data.notes.length &&
            !result.data.unavailable && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No transcript linked to this meeting yet.
              </p>
            )}
        </>
      )}
    </section>
  );
}
