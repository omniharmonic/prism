import { useMemo, useState } from "react";
import { useAgentConversation } from "../../../packages/core/src/lib/agent/useAgentConversation";
import type {
  AgentClient,
  AgentSession,
} from "../../../packages/core/src/lib/agent/sessions";
const controls = {
  streams: [] as string[],
  cancelled: [] as string[],
  resolve: null as null | (() => void),
};
Object.assign(window, { prismLifecycle: controls });

export function AgentLifecycleFixture() {
  const [sessionId, setSessionId] = useState("first");
  const client = useMemo(() => {
    return {
      scope: () => "fixture",
      getSession: async (id: string) => ({
        session: {
          id,
          title: id,
          status: "idle",
          permission_mode: "read-only",
          note_id: "fixture",
        } as AgentSession,
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
    } as AgentClient;
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
