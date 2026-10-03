/**
 * Wave 3A fixture (templates with variables, import, export, print): the
 * pages-and-navigation fixture (the real workspace over an in-page fake server)
 * plus the import/export routes (`transfer-server.ts`), a template that uses
 * variables, a page with an image, and an owner viewer role.
 *
 * Query flags (besides pages-nav's): ?dark (dark theme) · ?member (a member:
 * no Import / Export workspace commands) · ?viewer (every page is read as a
 * view-only share: `_caps: ["view"]`).
 *
 * Slice B (NP-TX-01): the copy-attachments route is faked here (recorded in
 * `prismFixtureWrites` as `{copyAttachments: <id>}`), and `prismTransfer.pages`
 * is the pages UI store (opens the Templates gallery without the sidebar).
 */
import type { Note } from "@prism/core";
import { useTransferUI } from "@prism/core";
import { createTransferServer, type FixtureAttachment } from "./transfer-server";
import { usePagesUI } from "../../../packages/core/src/lib/pages/store";

const params = new URLSearchParams(location.search);
if (params.has("dark")) {
  document.documentElement.classList.remove("light");
  document.documentElement.classList.add("dark");
}
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const IMAGE_ID = "a_fixtureImage0000000001";
const attachments = new Map<string, FixtureAttachment>([[IMAGE_ID, { name: "Team photo.png", mime: "image/png", bytes: PNG }]]);
let server: ReturnType<typeof createTransferServer> | null = null;
let seeded: Note[] = [];

Object.assign(window, {
  prismFixtureExtension: {
    seed(notes: Note[], doc: (id: string, path: string, html: string, extra?: Partial<Note>) => Note, stamp: () => string) {
      // A template that uses every variable, in the body and in properties.
      notes.push(doc("tpl-daily", "_templates/Daily log", "<h2>Log for @today</h2><p>Started @now by @me.</p><p>Mail me@today.example or use <code>@today</code> literally.</p>", { tags: ["template", "journal"], metadata: { type: "document", title: "Daily log", date: "@today", started: "@now", author: "@me", status: "open" } }));
      // The project page shows an image stored as an attachment.
      const prism = notes.find((n) => n.id === "prism")!;
      prism.content = `<h2>About</h2><p>The Prism project page.</p><img src="/api/attachments/${IMAGE_ID}" alt="Team photo">`;
      prism.metadata = { ...prism.metadata, status: "active", prism_creator: "owner@example.test" };
      seeded = notes;
      server = createTransferServer({ notes, stamp, attachments });
      Object.assign(window, { prismTransfer: { requests: server.requests, attachments, ui: useTransferUI, pages: usePagesUI } });
    },
    async fetch(url: URL, method: string, init?: RequestInit) {
      // Attachment bytes (the page's <img>, and imported images) come from the fixture's store.
      const att = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (att) {
        const a = attachments.get(att[1]!);
        return a ? new Response(a.bytes as BodyInit, { headers: { "Content-Type": a.mime } }) : Response.json({ error: "not_found" }, { status: 404 });
      }
      // A copied page gets its own files (POST /api/notes/:id/attachments/copy).
      const copy = url.pathname.match(/^\/api\/notes\/([^/]+)\/attachments\/copy$/);
      if (copy && method === "POST") {
        (window as unknown as { prismFixtureWrites: Array<Record<string, unknown>> }).prismFixtureWrites.push({ copyAttachments: decodeURIComponent(copy[1]!) });
        return Response.json({ copied: 1, failed: 0, skipped: 0, errors: 0, more: false });
      }
      // ?viewer: a single page read answers like a view-only share.
      const one = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (one && method === "GET" && params.has("viewer")) {
        const id = decodeURIComponent(one[1]!);
        const note = seeded.find((n) => n.id === id || n.path === id);
        if (note) return Response.json({ ...note, _caps: ["view"] });
      }
      return server ? server.handle(url, method, init) : null;
    },
    sharing: {
      getViewer: async () => ({ email: params.has("member") ? "member@example.test" : "owner@example.test", role: params.has("member") ? ("member" as const) : ("owner" as const), isServerOwner: !params.has("member"), vaultId: "primary" }),
    },
  },
});

await import("./pages-nav");
