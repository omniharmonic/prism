import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveActionsProvider, PlatformProvider, type Note } from "@prism/core";
import EmailRenderer from "../../../packages/core/src/components/renderers/EmailRenderer";
import type { LiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import { MessageThread } from "../../../packages/core/src/components/comms/MessageThread";
import { MessageComposer } from "../../../packages/core/src/components/comms/MessageComposer";
import type { MatrixMessage } from "../../../packages/core/src/lib/matrix/types";
import { createHttpLiveActionsClient } from "../../../packages/core/src/lib/actions/client";
const message = (id: number): MatrixMessage => ({
  event_id: `event-${id}`,
  sender: id % 2 ? "@morgan:example.test" : "@alex:example.test",
  sender_name: id % 2 ? "Morgan" : "Alex",
  timestamp: 1790870400000 + id * 60_000,
  body: `Message ${id}\nA second line with context.`,
  is_outgoing: false,
  msg_type: "m.text",
  media_url: null,
  media_info: null,
});
const controls = { reject: true, attempts: 0 };
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const emailNote: Note = {
  id: "email-fixture",
  path: "Email/A useful conversation",
  content:
    "# A useful conversation\n\n**From:** Morgan <morgan@example.test>\n**To:** Alex <alex@example.test>\n**Date:** 2026-10-01 10:00\n\n---\n\nFirst line\n# A heading inside the message\nKeep this---exactly.\n\n---\n\nFinal paragraph.",
  metadata: {
    type: "email",
    subject: "A useful conversation",
    from: "Morgan <morgan@example.test>",
    account: "alex@example.test",
    messageId: "fixture@example.test",
    source: "proton-bridge",
  },
  tags: ["email"],
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
if (location.search.includes("noaccount")) delete emailNote.metadata.account;
if (location.search.includes("draft")) emailNote.metadata.status = "draft";
Object.assign(window, {
  prismMessagesFixture: controls,
  prismActionsFactory: createHttpLiveActionsClient,
});
function Fixture() {
  const [messages, setMessages] = useState(
    Array.from({ length: 30 }, (_, i) => message(i + 10)),
  );
  const [room, setRoom] = useState("room-a");
  const [actor, setActor] = useState("alex");
  const scope = JSON.stringify([
    "https://fixture.example.test/api",
    "workspace",
    "vault",
    actor,
  ]);
  const emailClient = {
    scope: () => scope,
    status: async () => ({
      email: {
        enabled: !location.search.includes("unavailable"),
        configured: true,
      },
      matrix: { enabled: false, configured: false, agentRooms: 0 },
      calendar: { enabled: false, configured: false },
    }),
    emailReply: async (_params, options) => {
      controls.attempts++;
      const key = options?.idempotencyKey;
      if (!key) throw new Error("Missing retry identifier");
      const accepted: string[] = JSON.parse(
        localStorage.getItem("fixture-email-accepted") ?? "[]",
      );
      if (!accepted.includes(key)) {
        localStorage.setItem(
          "fixture-email-accepted",
          JSON.stringify([...accepted, key]),
        );
        throw new Error("Fixture lost email acknowledgement");
      }
      return { messageId: "accepted", inReplyTo: "fixture@example.test" };
    },
  } as LiveActionsClient;
  if (location.search.includes("email"))
    return (
      <QueryClientProvider client={queryClient}>
        <PlatformProvider
          value={location.search.includes("native") ? "desktop" : "web"}
        >
          <LiveActionsProvider client={emailClient}>
            <div style={{ height: "100dvh" }}>
              <EmailRenderer
                note={emailNote}
                readOnly={location.search.includes("readonly")}
              />
            </div>
          </LiveActionsProvider>
        </PlatformProvider>
      </QueryClientProvider>
    );
  return (
    <div
      style={{ height: "100dvh", maxWidth: 720, margin: "auto" }}
      className="flex flex-col"
    >
      <div className="p-2 flex gap-4">
        <button
          onClick={() => setMessages((old) => [message(1), message(2), ...old])}
        >
          Prepend history
        </button>
        <button
          onClick={() =>
            setMessages((old) => [...old, message(old.length + 40)])
          }
        >
          Receive message
        </button>
      </div>
      <div className="flex flex-wrap gap-3 px-2 text-xs">
        <button onClick={() => setRoom("room-a")}>Room A</button>
        <button onClick={() => setRoom("room-b")}>Room B</button>
        <button onClick={() => setActor("alex")}>Alex account</button>
        <button onClick={() => setActor("morgan")}>Morgan account</button>
      </div>
      <MessageThread messages={messages} />
      <MessageComposer
        draftScope={scope}
        draftKey={room}
        retrySafe
        onSend={async (body, { requestId }) => {
          controls.attempts++;
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (new URLSearchParams(location.search).has("lost")) {
            if (!requestId) throw new Error("Missing request identifier");
            const ids: string[] = JSON.parse(
              localStorage.getItem("fixture-message-accepted") ?? "[]",
            );
            if (!ids.includes(requestId)) {
              localStorage.setItem(
                "fixture-message-accepted",
                JSON.stringify([...ids, requestId]),
              );
              throw new Error("Fixture lost response after acceptance");
            }
          } else if (controls.reject) throw new Error("fixture failure");
          setMessages((old) => [
            ...old,
            { ...message(99), body, is_outgoing: true },
          ]);
        }}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
