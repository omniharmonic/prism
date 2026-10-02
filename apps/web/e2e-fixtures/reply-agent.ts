import type {
  AgentClient,
  AgentSessionDetail,
  AgentTurn,
  CreateSessionParams,
} from "../../../packages/core/src/lib/agent/sessions";

const prefix = "fixture-agent-reply:";
export const agentControls = {
  creates: [] as CreateSessionParams[],
  sends: [] as Array<{ sessionId: string; prompt: string; requestId?: string }>,
  streams: 0,
  unsubscribes: 0,
  cancellations: 0,
  deferred: [] as Array<() => void>,
  complete() {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (!key.startsWith(prefix)) continue;
      const detail: AgentSessionDetail = JSON.parse(localStorage.getItem(key)!);
      for (const turn of detail.turns) {
        turn.status = "done";
        turn.finalText =
          "Thanks, Morgan. Tuesday afternoon works well. I’ll send the agenda beforehand.";
      }
      localStorage.setItem(key, JSON.stringify(detail));
    }
  },
};
function read(id: string): AgentSessionDetail {
  const value = localStorage.getItem(prefix + id);
  if (!value) throw Error("Fixture session missing");
  return JSON.parse(value);
}
export function replyAgent(scope: () => string): AgentClient {
  return {
    scope,
    listSessions: async () => [],
    getLimits: async () => ({
      billing: "api",
      session: { limitUsd: 1 },
      daily: { limitUsd: 5, spentUsd: 0, remainingUsd: 5, resetsAt: 0 },
      profiles: ["prism-ro"],
      defaultProfile: "prism-ro",
      permissionModes: ["read-only"],
      idempotentRequests: true,
    }),
    createSession: async (params = {}) => {
      agentControls.creates.push(params);
      const id = `session-${params.requestId}`;
      const existing = localStorage.getItem(prefix + id);
      if (!existing) {
        const detail: AgentSessionDetail = {
          session: {
            id,
            vault_id: "vault",
            owner_email: "alex@example.test",
            title: params.title ?? "",
            profile: params.profile ?? "prism-ro",
            permission_mode: params.permissionMode,
            note_id: params.noteId ?? null,
            cli_session_id: null,
            status: "idle",
            transcript_note_id: null,
            cost_usd: 0,
            created_at: 1,
            updated_at: 1,
          },
          turns: [],
          lastSeq: 0,
        };
        localStorage.setItem(prefix + id, JSON.stringify(detail));
        if (location.search.includes("lostcreate"))
          throw Error("Fixture lost create acknowledgement");
      }
      return { sessionId: id, session: read(id).session };
    },
    getSession: async (id) => read(id),
    sendTurn: async (sessionId, prompt, opts) => {
      agentControls.sends.push({
        sessionId,
        prompt,
        requestId: opts?.requestId,
      });
      const detail = read(sessionId);
      const id = `turn-${opts?.requestId}`;
      let turn = detail.turns.find((item) => item.id === id);
      if (!turn) {
        turn = {
          id,
          session_id: sessionId,
          prompt,
          note_id: opts?.noteId ?? null,
          status:
            location.search.includes("pending") ||
            location.search.includes("deferred")
              ? "running"
              : "done",
          pid: null,
          exit_code: null,
          error: null,
          cost_usd: 0,
          started_at: 1,
          ended_at: 2,
          finalText: detail.session.title?.startsWith("Conversation summary:") ? "The team agreed to meet Tuesday. The agenda is still an open question." :
            "Thanks, Morgan. Tuesday afternoon works well. I’ll send the agenda beforehand.",
          tools: [],
          touched: [],
          firstSeq: 1,
          lastSeq: 1,
        } satisfies AgentTurn;
        detail.turns.push(turn);
        localStorage.setItem(prefix + sessionId, JSON.stringify(detail));
        if (location.search.includes("lostturn"))
          throw Error("Fixture lost generation acknowledgement");
      }
      if (location.search.includes("deferred"))
        await new Promise<void>((resolve) =>
          agentControls.deferred.push(resolve),
        );
      return { turnId: turn.id, status: turn.status };
    },
    streamSession: () => {
      agentControls.streams++;
      return () => {
        agentControls.unsubscribes++;
      };
    },
    cancelTurn: async () => {
      agentControls.cancellations++;
      return true;
    },
    archiveSession: async () => {},
  };
}
