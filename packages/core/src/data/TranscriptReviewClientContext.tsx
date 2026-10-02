import { createContext, useContext, type ReactNode } from "react";

export interface TranscriptReviewItem {
  id: string;
  title: string;
  start?: string;
  updatedAt: string;
  decisionRevision: number;
  canManage: boolean;
}
export interface TranscriptCandidate extends TranscriptReviewItem {
  score: number;
  evidence: string[];
  linkedElsewhere: boolean;
}
export interface TranscriptReview {
  meeting: { id: string; eventId: string; title: string; updatedAt: string };
  linked: TranscriptReviewItem[];
  candidates: TranscriptCandidate[];
  limited: boolean;
  canManage: boolean;
}
export interface TranscriptDecision {
  transcriptId: string;
  action: "link" | "unlink";
  reason: string;
  meetingUpdatedAt: string;
  transcriptUpdatedAt: string;
  expectedRevision: number;
  requestId: string;
}
export interface TranscriptReviewClient {
  scope(): string | null;
  review(meetingId: string, query?: string): Promise<TranscriptReview>;
  decide(
    meetingId: string,
    decision: TranscriptDecision,
  ): Promise<{ status: "applied" | "pending"; revision: number }>;
}
const Context = createContext<TranscriptReviewClient | null>(null);
export function TranscriptReviewClientProvider({
  client,
  children,
}: {
  client: TranscriptReviewClient | null;
  children: ReactNode;
}) {
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
export function useTranscriptReviewClient() {
  return useContext(Context);
}
