// A note's governed history: every approved revision, whether it is live or still
// staged, and the two things you can do with the past — roll a note back to a
// prior revision, or fork it and propose the fork back.
//
// Fork/merge is how disagreement stays productive in a commons: you never have to
// win the argument to keep working, and the merge is judged by the same rule as
// any other edit.
import { useState } from "react";
import { History, GitFork, RotateCcw } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Badge } from "../../../ui/Badge";
import { Input } from "../../../ui/Input";
import { govApi, type Revision } from "./api";
import type { GovCtx } from "./ctx";
import { Section, ago, row, subCard } from "./ui";

export function HistoryCard({ ctx }: { ctx: GovCtx }) {
  const [noteId, setNoteId] = useState("");
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [forkId, setForkId] = useState<string | null>(null);

  const load = async () => {
    const r = await govApi.revisions(noteId.trim());
    setRevisions(r.ok ? (r.data.revisions ?? []) : []);
  };

  return (
    <Section
      icon={<History size={16} />}
      title="A note's history"
      subtitle="Look up any note's governed revisions — then roll back, or fork it and propose the fork back."
      testId="gov-history"
    >
      <div style={row}>
        <Input placeholder="note id" value={noteId} onChange={(e) => setNoteId(e.target.value)} style={{ width: 280 }} data-testid="gov-history-note" />
        <Button onClick={() => void load()} data-testid="gov-history-load">
          Show history
        </Button>
        <Button
          variant="ghost"
          icon={<GitFork size={13} />}
          data-testid="gov-history-fork"
          onClick={() =>
            void ctx.run(() => govApi.fork(noteId.trim())).then((r) => {
              if (r.ok && r.data?.id) setForkId(r.data.id);
            })
          }
        >
          Fork it
        </Button>
      </div>

      {forkId && (
        <div style={{ ...row, marginTop: 10 }}>
          <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>Your fork: {forkId}</span>
          <Button size="sm" onClick={() => void ctx.run(() => govApi.proposeMerge(forkId))}>
            Propose merging it back
          </Button>
        </div>
      )}

      {revisions !== null && revisions.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 10 }}>No governed revisions for this note.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {(revisions ?? []).map((r) => (
          <div key={r.id} style={{ ...subCard, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
              {r.origin} by {r.author} · {ago(r.at)}
            </span>
            {r.published ? <Badge variant="success">live</Badge> : <Badge>staged</Badge>}
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={12} />}
              onClick={() => void ctx.run(() => govApi.rollback(noteId.trim(), r.id)).then(() => load())}
            >
              Roll back to this
            </Button>
          </div>
        ))}
      </div>
    </Section>
  );
}
