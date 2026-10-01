import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@prism/core";
import { MessageThread } from "../../../packages/core/src/components/comms/MessageThread";
import { MessageComposer } from "../../../packages/core/src/components/comms/MessageComposer";
import type { MatrixMessage } from "../../../packages/core/src/lib/matrix/types";
import { createHttpLiveActionsClient } from "../../../packages/core/src/lib/actions/client";
const message = (id: number): MatrixMessage => ({ event_id: `event-${id}`, sender: id % 2 ? "@morgan:example.test" : "@alex:example.test", sender_name: id % 2 ? "Morgan" : "Alex", timestamp: 1790870400000 + id * 60_000, body: `Message ${id}\nA second line with context.`, is_outgoing: false, msg_type: "m.text", media_url: null, media_info: null });
const controls = { reject: true, attempts: 0 };
Object.assign(window, { prismMessagesFixture: controls, prismActionsFactory: createHttpLiveActionsClient });
function Fixture() {
  const [messages, setMessages] = useState(Array.from({ length: 30 }, (_, i) => message(i + 10)));
  const [room, setRoom] = useState("room-a");
  const [actor, setActor] = useState("alex");
  const scope = JSON.stringify(["https://fixture.example.test/api", "workspace", "vault", actor]);
  return <div style={{ height: "100dvh", maxWidth: 720, margin: "auto" }} className="flex flex-col">
    <div className="p-2 flex gap-4"><button onClick={() => setMessages((old) => [message(1), message(2), ...old])}>Prepend history</button><button onClick={() => setMessages((old) => [...old, message(old.length + 40)])}>Receive message</button></div>
    <div className="flex flex-wrap gap-3 px-2 text-xs"><button onClick={() => setRoom("room-a")}>Room A</button><button onClick={() => setRoom("room-b")}>Room B</button><button onClick={() => setActor("alex")}>Alex account</button><button onClick={() => setActor("morgan")}>Morgan account</button></div>
    <MessageThread messages={messages} />
    <MessageComposer draftScope={scope} draftKey={room} retrySafe onSend={async (body, { requestId }) => {
      controls.attempts++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (new URLSearchParams(location.search).has("lost")) {
        if (!requestId) throw new Error("Missing request identifier");
        const ids: string[] = JSON.parse(localStorage.getItem("fixture-message-accepted") ?? "[]");
        if (!ids.includes(requestId)) { localStorage.setItem("fixture-message-accepted", JSON.stringify([...ids, requestId])); throw new Error("Fixture lost response after acceptance"); }
      } else if (controls.reject) throw new Error("fixture failure");
      setMessages((old) => [...old, { ...message(99), body, is_outgoing: true }]);
    }} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
