import type { TranscriptReviewClient } from "@prism/core/shell";
import { agentScope } from "./config";
import { managementRequest } from "./collab/grant";
export const httpTranscriptReviewClient: TranscriptReviewClient = {
  scope: agentScope,
  async review(meetingId, query) {
    const search = query ? "?query=" + encodeURIComponent(query) : "";
    return (
      await managementRequest(
        "/api",
        "/transcripts/events/" + encodeURIComponent(meetingId) + search,
      )
    ).json();
  },
  async decide(meetingId, decision) {
    return (
      await managementRequest(
        "/api",
        "/transcripts/events/" + encodeURIComponent(meetingId) + "/decisions",
        { method: "POST", body: JSON.stringify(decision) },
      )
    ).json();
  },
};
