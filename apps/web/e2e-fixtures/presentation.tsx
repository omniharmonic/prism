import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabSharingProvider,
  VaultClientProvider,
  PublicationPreviewProvider,
  type PublicationPresentationState,
  type PublicationPresentation,
  type VaultClient,
} from "@prism/core";
import { PublishPanel } from "../../../packages/core/src/components/renderers/network/PublishPanel";
import PresentationPreview from "../src/publish/PresentationPreview";
import { webCollabSharing } from "../src/collab/grant";
import { fetchMe, agentScope } from "../src/config";
const initial: PublicationPresentation = {
  title: "Field guide",
  template: "wiki",
  theme: { font: "sans" },
};
let state: PublicationPresentationState = {
  liveRevision: 0,
  draftRevision: 0,
  draftBaseRevision: null,
  live: initial,
  draft: null,
  history: [
    { revision: 0, createdAt: 1, createdBy: null, presentation: initial },
  ],
};
state =
  JSON.parse(sessionStorage.getItem("fixture-presentation") ?? "null") ?? state;
const controls = {
  fail: false,
  previewFail: false,
  hold: false,
  release: null as (() => void) | null,
  published: 0,
  writes: [] as object[],
  remote: () => {
    state = {
      ...state,
      liveRevision: state.liveRevision + 1,
      live: { ...state.live, title: "Remote title" },
    };
  },
};
Object.assign(window, { prismPresentationFixture: controls });
const clone = <T,>(v: T): T => structuredClone(v);
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const original = window.fetch.bind(window);
const notes = [
  { id: "welcome", title: "Welcome", path: "guide/welcome.md", tags: [] },
  { id: "reference", title: "Reference", path: "guide/reference.md", tags: [] },
];
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
      email: "owner@example.test",
      vaultId: "primary",
      isOwner: true,
      workspace: { id: "personal" },
    });
  if (!url.pathname.startsWith("/acl/")) return original(input, init);
  const path = url.pathname;
  if (path === "/acl/publications")
    return json([
      {
        slug: "guide",
        kind: "path",
        pathPrefix: "guide",
        tag: "",
        ...state.live,
        passwordRequired: true,
        url: "https://prism.example.test/p/guide",
        createdAt: 1,
      },
    ]);
  if (path.endsWith("/presentation/preview")) {
    const result = state.draft
      ? {
          manifest: {
            slug: "guide",
            ...clone(state.draft),
            homeNoteId: "welcome",
            passwordRequired: true,
            locked: false,
            notes,
            mapFeatureCount: 0,
          },
          note: {
            ...notes.find(
              (n) => n.id === (url.searchParams.get("noteId") ?? "welcome"),
            )!,
            content: "# Preview\n\nPRISM_DRAFT_PREVIEW_BODY",
            metadata: null,
          },
          graph: { nodes: notes, edges: [] },
          mapFeatures: [],
          expired: false,
        }
      : null;
    if (controls.previewFail)
      return json({ error: "Synthetic preview unavailable" }, 503);
    if (controls.hold)
      await new Promise<void>((r) => {
        controls.release = r;
      });
    return result ? json(result) : json({}, 409);
  }
  if (path.endsWith("/preview"))
    return json({
      slug: "guide",
      vaultId: "primary",
      notes: notes.map((n) => ({ ...n, excluded: false })),
      privateExcludedCount: 1,
      publishedCount: 2,
      expired: false,
    });
  if (path.endsWith("/presentation")) return json(clone(state));
  if (path.includes("/presentation/")) {
    const body = JSON.parse(String(init?.body));
    controls.writes.push(body);
    if (controls.fail)
      return json({ error: "Synthetic write unavailable" }, 503);
    if (
      body.draftRevision !== state.draftRevision ||
      body.liveRevision !== state.liveRevision
    )
      return json(
        {
          error: "presentation_conflict",
          detail: "Site settings changed in another session.",
        },
        409,
      );
    if (path.endsWith("/draft"))
      state = {
        ...state,
        draft: body.presentation,
        draftRevision: state.draftRevision + 1,
        draftBaseRevision: state.liveRevision,
      };
    if (path.endsWith("/restore"))
      state = {
        ...state,
        draft: clone(
          state.history.find((h) => h.revision === body.revision)!.presentation,
        ),
        draftRevision: state.draftRevision + 1,
        draftBaseRevision: state.liveRevision,
      };
    if (path.endsWith("/publish")) {
      controls.published++;
      state = {
        ...state,
        live: state.draft!,
        liveRevision: state.liveRevision + 1,
        draft: null,
        draftRevision: state.draftRevision + 1,
        draftBaseRevision: null,
      };
      state.history.unshift({
        revision: state.liveRevision,
        createdAt: Date.now(),
        createdBy: "owner@example.test",
        presentation: clone(state.live),
      });
    }
    sessionStorage.setItem("fixture-presentation", JSON.stringify(state));
    return json(clone(state));
  }
  return json({}, 404);
};
await fetchMe();
const vault = {
  scope: () => agentScope(),
  getTags: async () => [],
} as unknown as VaultClient;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VaultClientProvider client={vault}>
      <CollabSharingProvider value={webCollabSharing}>
        <PublicationPreviewProvider component={PresentationPreview}>
          <main style={{ maxWidth: 1000, margin: "auto", padding: 16 }}>
            <PublishPanel />
          </main>
        </PublicationPreviewProvider>
      </CollabSharingProvider>
    </VaultClientProvider>
  </React.StrictMode>,
);
