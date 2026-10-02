import { useMemo, useState } from "react";
import { useAgentConversation } from "../../../packages/core/src/lib/agent/useAgentConversation";
import type {
  AgentClient,
} from "../../../packages/core/src/lib/agent/sessions";
const controls = {
  streams: [] as string[],
  cancelled: [] as string[],
  resolve: null as null | (() => void),
};
Object.assign(window, { prismLifecycle: controls });

export function AgentLifecycleFixture() {
  const [sessionId, setSessionId] = useState("first");
  const client = useMemo<AgentClient>(() => {
    return {
      scope: () => "fixture",
      createSession: async () => { throw new Error("This lifecycle fixture uses existing sessions only"); },
      listSessions: async () => [],
      archiveSession: async () => {},
      getSession: async (id: string) => ({
        session: {
          id,
          vault_id: "fixture-vault",
          owner_email: "alex@example.test",
          profile: "prism-ro",
          cli_session_id: null,
          transcript_note_id: null,
          cost_usd: 0,
          created_at: 1,
          updated_at: 1,
          title: id,
          status: "idle",
          permission_mode: "read-only",
          note_id: "fixture",
        },
        turns: [],
      }),
      sendTurn: async () => {
        await new Promise<void>((resolve) => {
          controls.resolve = resolve;
        });
        return { turnId: "late-turn", status: "running" as const };
      },
      streamSession: (id: string) => {
        controls.streams.push(id);
        return () => {};
      },
      cancelTurn: async (id: string) => {
        controls.cancelled.push(id);
        return true;
      },
    };
  }, []);
  const conversation = useAgentConversation(client, sessionId);
  return (
    <main>
      <p>Session: {conversation.session?.id}</p>
      <button
        disabled={conversation.loading}
        onClick={() => void conversation.send("Prepare a draft")}
      >
        Start deferred turn
      </button>
      <button onClick={() => setSessionId("second")}>Switch session</button>
      <p role="status">{conversation.error}</p>
    </main>
  );
}
