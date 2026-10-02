import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TranscriptReviewClientProvider,
  type TranscriptReview,
  type TranscriptDecision,
} from "@prism/core";
import { EventTranscripts } from "../../../packages/core/src/components/comms/EventTranscripts";
import { httpTranscriptReviewClient } from "../src/transcript-review";
import { fetchMe } from "../src/config";
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
const controls = {
  fail: false,
  conflict: false,
  pending: false,
  hold: false,
  release: null as (() => void) | null,
  writes: [] as TranscriptDecision[],
  headers: [] as object[],
  opens: [] as string[],
  reads: [] as string[],
  switchScope: async () => {
    audience = "other";
    await fetchMe();
  },
};
Object.assign(window, { prismTranscriptFixture: controls });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
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
    const result = structuredClone(state);
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
    if (controls.fail) return json({ error: "synthetic_failure" }, 503);
    if (controls.conflict) {
      state.meeting.updatedAt = "meeting-v2";
      controls.conflict = false;
      return json({ error: "revision_conflict" }, 409);
    }
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
    return json({ status: "applied", revision: body.expectedRevision + 1 });
  }
  return original(input, init);
};
await fetchMe();
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <TranscriptReviewClientProvider client={httpTranscriptReviewClient}>
        <main style={{ maxWidth: 520, margin: "0 auto", padding: 16 }}>
          <EventTranscripts
            noteId="meeting"
            eventId="event"
            onOpen={(id) => controls.opens.push(id)}
          />
        </main>
      </TranscriptReviewClientProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
