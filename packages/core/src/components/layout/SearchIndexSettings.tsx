import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { hostServiceErrorText, type HostServices } from "../../lib/host/services";

export function SearchIndexSettings({ host }: { host: HostServices }) {
  const audience = useAgentChatStore(state => state.scope);
  const scope = host.scope?.() ?? audience;
  // Remount pending actions/messages when account, vault or server changes.
  return host.searchIndex ? <IndexDetails key={scope} host={host} scope={scope ?? ""} /> : null;
}

function IndexDetails({ host, scope }: { host: HostServices; scope: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["search-index", scope], queryFn: () => host.searchIndex!.status(), retry: false,
    refetchInterval: q => ["queued", "running", "pausing"].includes(q.state.data?.job?.state ?? "") ? 1500 : 30_000 });
  const data = query.isError ? undefined : query.data;
  const job = data?.job;
  const running = job && ["queued", "running", "pausing"].includes(job.state);
  async function act(action: "start" | "pause" | "resume") {
    if (pending || (host.scope && host.scope() !== scope)) return;
    setPending(true); setError("");
    try {
      const client = host.searchIndex!;
      if (action === "start") await client.start();
      else if (job) await client[action](job.id);
      await query.refetch();
    } catch (e) { setError(hostServiceErrorText(e)); }
    finally { setPending(false); }
  }
  const button = "focus-ring rounded-lg border border-[var(--glass-border)] px-3 py-2 text-xs disabled:opacity-50";
  return <section aria-label="Search index" className="space-y-3 rounded-xl border border-[var(--glass-border)] p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Search</h3>
      <button className={button} disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh status</button></div>
    {query.isLoading && <p role="status">Checking search…</p>}
    {query.isError && <p role="alert">Couldn’t check search. Reconnect and refresh status.</p>}
    {data && <>
      <p>{data.notes.toLocaleString()} notes indexed · {data.semantic ? "Meaning and keyword search" : "Keyword matching"}</p>
      <p className="text-xs text-[var(--text-secondary)]">{data.automatic ? "This vault updates automatically in the background." : "Update this vault’s search after adding or changing notes."} An update keeps existing search available and leaves your documents unchanged.</p>
      {job && <div className="space-y-2" role="status">
        <p>{job.state === "completed" ? "Update complete" : job.state === "pausing" ? "Pausing after the current note…" : job.state === "paused" ? "Update paused" : job.state === "failed" ? "Update needs attention" : "Updating search…"}
          {job.total > 0 && ` · ${job.processed.toLocaleString()} of ${job.total.toLocaleString()} checked`}</p>
        {job.total > 0 && <progress aria-label="Search update progress" className="workspace-progress" value={job.processed} max={job.total} />}
        {job.failed > 0 && <p className="text-xs">{job.failed} notes need retrying. Completed notes are kept.</p>}
        {job.error && <p className="text-xs text-[var(--text-secondary)]">{job.error}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {running ? <button className={button} disabled={pending || job.state === "pausing"} onClick={() => void act("pause")}>Pause update</button>
          : <><button className={button} disabled={pending} onClick={() => void act("start")}>Update search</button>
            {job && ["paused", "failed"].includes(job.state) && <button className={button} disabled={pending} onClick={() => void act("resume")}>{job.state === "failed" ? "Retry unfinished notes" : "Resume update"}</button>}</>}
      </div>
    </>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </section>;
}
