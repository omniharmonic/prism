import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollabEditor, type Editor } from "@prism/core";
import * as Y from "yjs";
import {
  captureHumanSelection,
  humanTextProblem,
  suggestionTextProblem,
  parseHumanCommand,
  humanRangeProblem,
} from "../../../packages/core/src/lib/collab/human/validation";
import { humanCollabRevision } from "@prism/core/collab-commands";
import {
  humanReceiptKey,
  readHumanReceipt,
  reserveHumanReceipt,
  clearHumanReceipt,
} from "../../../packages/core/src/lib/collab/human/receipt";
import {
  humanCommandsFor,
  type HumanCommandContext,
} from "../src/collab/humanCommands";
const ydoc = new Y.Doc();
let editor: Editor | null = null;
const content = new URLSearchParams(location.search).has("empty")
  ? "<p></p>"
  : '<p>Alpha <strong>beta</strong> gamma</p><p>Another paragraph</p><p>Code <code>literal</code> text</p><p>A<br>break</p><p><span data-suggestion="insert" data-suggestion-id="pending" data-user="Another person">Pending</span> text</p><p data-suggestion-node="insert" data-suggestion-by="Another person">Suggested paragraph</p><p>Tail<br data-suggestion-node="delete" data-suggestion-by="Another person">end</p>';
const state = {
  credentials: undefined as RequestCredentials | undefined,
  audience: null as HumanCommandContext | null,
  refresh: null as null | (() => Promise<HumanCommandContext | null>),
  setAudience: () => {
    state.audience = {
      audience: {
        origin: location.origin,
        workspace: "fixture-workspace",
        vault: "fixture-vault",
        actorId: "h_fixture_actor",
        credentialKey: "fixture-cap-hash",
      },
      capabilityToken: "fixture-link-token",
    };
  },
  send: (body: string) =>
    humanCommandsFor("real_note_id", {
      current: () => state.audience,
      revalidate: () => state.refresh?.() ?? Promise.resolve(state.audience),
    })(body),
  capture: (action: Parameters<typeof captureHumanSelection>[2]) =>
    captureHumanSelection(editor!, ydoc, action, true),
  select: (from: number, to = from) =>
    editor!.commands.setTextSelection({ from, to }),
  json: () => editor!.state.doc.toJSON(),
  html: () => editor!.getHTML(),
  revision: () =>
    humanCollabRevision(
      editor!.state.doc.toJSON(),
      ydoc.getMap("comments").toJSON(),
    ),
  comment: () => ydoc.getMap("comments").set("fixture-comment", "changed"),
  problem: (from: number, to: number) =>
    humanRangeProblem(editor!.state.doc, from, to, "suggest"),
  textProblem: humanTextProblem,
  suggestionTextProblem,
  parseHumanCommand,
  receiptKey: humanReceiptKey(
    "authoritative-fictional-audience",
    "real_note_id",
  ),
  read: readHumanReceipt,
  reserve: reserveHumanReceipt,
  clear: clearHumanReceipt,
};
const fixtureFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (String(input).includes("/api/collab/"))
    state.credentials = init?.credentials;
  return fixtureFetch(input, init);
};
Object.assign(window, { humanFixture: state });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <main style={{ maxWidth: 760, margin: "40px auto", padding: 20 }}>
      <h1>Command helper fixture</h1>
      <p>
        Read-only document. Command identity is unavailable; no production
        command UI is enabled.
      </p>
      <CollabEditor
        ydoc={ydoc}
        provider={null}
        user={{ name: "Fixture reader", color: "#2563eb" }}
        seedReady
        seedContent={async () => content}
        editable={false}
        canComment={false}
        canReview={false}
        onEditor={(value) => {
          editor = value;
        }}
      />
    </main>
  </QueryClientProvider>,
);
