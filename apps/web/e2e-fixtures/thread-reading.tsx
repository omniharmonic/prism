import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@prism/core";
import { MessageThread } from "../../../packages/core/src/components/comms/MessageThread";
import { MessageComposer } from "../../../packages/core/src/components/comms/MessageComposer";
import type { MatrixMessage } from "../../../packages/core/src/lib/matrix/types";
import {
  loadReadingPosition,
  saveReadingPosition,
} from "../../../packages/core/src/lib/messages/readingPosition";
const make = (id: number): MatrixMessage => ({
  event_id: `event-${id}`,
  sender: id % 2 ? "@morgan:example.test" : "@alex:example.test",
  sender_name: id % 2 ? "Morgan" : "Alex",
  timestamp: 1790870400000 + id * 60000,
  body: `Fictional reading message ${id}\nA second line of context.`,
  is_outgoing: false,
  msg_type: "m.text",
  media_url: null,
  media_info: null,
});
function Fixture() {
  const [actor, setActor] = useState("alex"),
    [vault, setVault] = useState("primary"),
    [room, setRoom] = useState("room-a"),
    [mode, setMode] = useState("saved"),
    [open, setOpen] = useState(true);
  const [start, setStart] = useState(
      new URLSearchParams(location.search).has("window") ? 50 : 0,
    ),
    [end, setEnd] = useState(80);
  const identity = {
    audience: JSON.stringify([actor, "https://fixture.example.test", vault]),
    conversation: JSON.stringify(["note-fixture", "matrix", room, mode]),
  };
  Object.assign(window, {
    prismReadingFixture: {
      identity,
      save: saveReadingPosition,
      load: loadReadingPosition,
      setActor,
      setVault,
      setRoom,
      setMode,
      setOpen,
      setStart,
      setEnd,
      expand: () => {
        const el = document.querySelector<HTMLElement>(
          '[data-message-id="event-0"]',
        );
        if (el) el.style.minHeight = "460px";
      },
    },
  });
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        maxWidth: 900,
        margin: "auto",
      }}
    >
      <div style={{ display: "flex", gap: 8, padding: 8 }}>
        <button onClick={() => setOpen((v) => !v)}>
          {open ? "Close thread" : "Reopen thread"}
        </button>
        <button onClick={() => setEnd((v) => v + 1)}>Receive message</button>
      </div>
      {open && (
        <MessageThread
          readingIdentity={identity}
          messages={Array.from({ length: end - start }, (_, i) =>
            make(start + i),
          )}
          hasMore={start > 0}
          onLoadMore={() => setStart(Math.max(0, start - 25))}
        />
      )}
      <MessageComposer
        draftScope={identity.audience}
        draftKey={room}
        onSend={async () => {}}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
