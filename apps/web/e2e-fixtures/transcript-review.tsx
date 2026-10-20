import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TranscriptReviewClientProvider,
  type TranscriptReview,
  type TranscriptDecision,
  PlatformProvider,
  VaultClientProvider,
  useUIStore,
  type VaultClient,
  type Note,
} from "@prism/core";
import { EventTranscripts } from "../../../packages/core/src/components/comms/EventTranscripts";
import { httpTranscriptReviewClient } from "../src/transcript-review";
import { fetchMe } from "../src/config";
import CalendarDashboard from "../../../packages/core/src/components/comms/CalendarDashboard";
import { transcriptReceiptKey } from "../../../packages/core/src/components/comms/transcriptReviewReceipt";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.remove("light");
const readonly = new URLSearchParams(location.search).has("readonly");
let audience = "owner";
let state: TranscriptReview = {
  meeting: {
    id: "meeting",
    eventId: "event",
    title: "Design review",
    updatedAt: "meeting-v1",
  },
  linked: [
    {
      id: "linked",
      title: "Existing meeting recording",
      updatedAt: "linked-v1",
      decisionRevision: 1,
      canManage: !readonly,
    },
  ],
  candidates: [
    {
      id: "candidate",
      title: "Design review recording",
      start: "2026-10-02T16:00:00Z",
      updatedAt: "candidate-v1",
      decisionRevision: 0,
      canManage: !readonly,
      linkedElsewhere: false,
      score: 5,
      evidence: [
        "The recording starts within five minutes of this meeting.",
        "The title matches Design review.",
      ],
    },
    {
      id: "elsewhere",
      title: "Other recording",
      updatedAt: "elsewhere-v1",
      decisionRevision: 3,
      canManage: !readonly,
      linkedElsewhere: true,
      score: 2,
      evidence: ["The participants overlap with this meeting."],
    },
    {
      id: "protected",
      title: "Read-only recording",
      updatedAt: "protected-v1",
      decisionRevision: 0,
      canManage: false,
      linkedElsewhere: false,
      score: 1,
      evidence: [],
    },
  ],
  limited: true,
  canManage: !readonly,
};
try {
  state =
    JSON.parse(sessionStorage.getItem("transcript-fixture-state") || "null") ??
    state;
} catch {
  /* fresh fixture */
}
const applied: Record<string, string> = JSON.parse(
  sessionStorage.getItem("transcript-fixture-applied") || "{}",
);
const controls = {
  fail: false,
  loseAppliedResponse: false,
  conflict: false,
  pending: false,
  hold: false,
  release: null as (() => void) | null,
  writes: JSON.parse(
    sessionStorage.getItem("transcript-fixture-writes") || "[]",
  ) as TranscriptDecision[],
  rawWrites: JSON.parse(
    sessionStorage.getItem("transcript-fixture-raw") || "[]",
  ) as string[],
  responseError: null as {
    status: number;
    code: string;
    retryAfter?: number;
  } | null,
  readError: null as {
    status: number;
    code: string;
    retryAfter?: number;
  } | null,
  receiptKey: () =>
    transcriptReceiptKey(httpTranscriptReviewClient.scope()!, "meeting"),
  headers: [] as object[],
  opens: [] as string[],
  reads: [] as string[],
  switchScope: async () => {
    audience = "other";
    await fetchMe();
  },
};
Object.assign(window, { prismTranscriptFixture: controls });
const json = (
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
const original = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  if (url.pathname === "/auth/me")
    return json({
      authenticated: true,
      email: audience + "@example.test",
      vaultId: "primary",
      isOwner: true,
      workspace: { id: "personal" },
    });
  if (url.pathname === "/api/transcripts/events/meeting") {
    controls.reads.push(url.searchParams.get("query") ?? "");
    if (controls.readError)
      return json(
        {
          error: controls.readError.code,
          retryAfter: controls.readError.retryAfter,
        },
        controls.readError.status,
        controls.readError.retryAfter
          ? { "Retry-After": String(controls.readError.retryAfter) }
          : {},
      );
    const result = structuredClone(state);
    if (params.has("dates")) result.candidates[0].start = "2026-10-02";
    if (audience !== "owner") {
      result.linked = [];
      result.candidates = [];
      result.canManage = false;
    }
    const query = url.searchParams.get("query")?.toLowerCase();
    if (query)
      result.candidates = result.candidates.filter((item) =>
        item.title.toLowerCase().includes(query),
      );
    return json(result);
  }
  if (url.pathname === "/api/transcripts/events/meeting/decisions") {
    const body = JSON.parse(String(init?.body)) as TranscriptDecision;
    controls.writes.push(body);
    controls.rawWrites.push(String(init?.body));
    sessionStorage.setItem(
      "transcript-fixture-writes",
      JSON.stringify(controls.writes),
    );
    sessionStorage.setItem(
      "transcript-fixture-raw",
      JSON.stringify(controls.rawWrites),
    );
    const headers = new Headers(init?.headers);
    controls.headers.push({
      vault: headers.get("X-Prism-Vault"),
      workspace: headers.get("X-Prism-Workspace"),
      actor: headers.get("X-Prism-Write-Actor"),
    });
    if (controls.hold)
      await new Promise<void>((resolve) => {
        controls.release = resolve;
      });
    if (controls.responseError)
      return json(
        {
          error: controls.responseError.code,
          retryAfter: controls.responseError.retryAfter,
        },
        controls.responseError.status,
        controls.responseError.retryAfter
          ? { "Retry-After": String(controls.responseError.retryAfter) }
          : {},
      );
    if (controls.fail) return json({ error: "transcripts_unavailable" }, 503);
    if (controls.conflict) {
      state.meeting.updatedAt = "meeting-v2";
      controls.conflict = false;
      return json({ error: "stale" }, 409);
    }
    if (applied[body.requestId])
      return applied[body.requestId] === String(init?.body)
        ? json({ status: "applied", revision: body.expectedRevision + 1 })
        : json({ error: "request_reused" }, 422);
    if (controls.pending)
      return json({ status: "pending", revision: body.expectedRevision + 1 });
    if (body.action === "link") {
      const item = state.candidates.find(
        (item) => item.id === body.transcriptId,
      )!;
      state.linked.push({
        ...item,
        decisionRevision: body.expectedRevision + 1,
      });
      state.candidates = state.candidates.filter(
        (item) => item.id !== body.transcriptId,
      );
    } else {
      const item = state.linked.find((item) => item.id === body.transcriptId)!;
      state.candidates.push({
        ...item,
        decisionRevision: body.expectedRevision + 1,
        evidence: [],
        linkedElsewhere: false,
        score: 0,
      });
      state.linked = state.linked.filter(
        (item) => item.id !== body.transcriptId,
      );
    }
    state.meeting.updatedAt = "meeting-v" + (controls.writes.length + 1);
    sessionStorage.setItem("transcript-fixture-state", JSON.stringify(state));
    applied[body.requestId] = String(init?.body);
    sessionStorage.setItem(
      "transcript-fixture-applied",
      JSON.stringify(applied),
    );
    if (controls.loseAppliedResponse)
      throw new TypeError("Network response lost");
    return json({ status: "applied", revision: body.expectedRevision + 1 });
  }
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/acl/")
  )
    return json({ error: "unsupported_fixture_route" }, 501);
  return original(input, init);
};
await fetchMe();
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const meeting: Note = {
  id: "meeting",
  path: "Meetings/Design review",
  content: "Meeting notes.",
  tags: ["meeting"],
  metadata: {
    title: "Design review",
    calendarEventId: "event",
    start: "2026-10-02T10:00:00-06:00",
    end: "2026-10-02T11:00:00-06:00",
    location: "Research studio",
    attendees: ["Morgan Lee", "Alex Rivera"],
  },
  createdAt: "2026-10-02",
  updatedAt: "meeting-v1",
};
const vault = {
  listNotes: async () => [meeting],
  getNote: async (id: string) =>
    id === "meeting"
      ? meeting
      : {
          ...meeting,
          id,
          path:
            "Transcripts/" +
            (state.linked.find((item) => item.id === id)?.title ?? id),
          tags: ["transcript"],
        },
  getLinks: async () =>
    state.linked.map((item) => ({
      sourceId: "meeting",
      targetId: item.id,
      relationship: "has-transcript",
    })),
} as unknown as VaultClient;
Object.assign(window, { prismTranscriptUI: useUIStore });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <PlatformProvider value="web">
        <VaultClientProvider client={vault}>
          <TranscriptReviewClientProvider
            client={params.has("legacy") ? null : httpTranscriptReviewClient}
          >
            {params.has("calendar") ? (
              <div style={{ height: "100dvh" }}>
                <CalendarDashboard note={{ ...meeting, id: "calendar" }} />
              </div>
            ) : (
              <main
                style={{
                  maxWidth: 520,
                  margin: "0 auto",
                  padding: 16,
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  minHeight: "100dvh",
                }}
              >
                <EventTranscripts
                  noteId={
                    params.has("alias") ? "Meetings/Design review" : "meeting"
                  }
                  eventId="event"
                  onOpen={(id) => controls.opens.push(id)}
                />
              </main>
            )}
          </TranscriptReviewClientProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
