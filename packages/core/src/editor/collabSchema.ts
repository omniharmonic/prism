import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import type { Extensions } from "@tiptap/core";
import { suggestionMarks } from "./suggestionMarks";
import { commentMarks } from "./commentMark";
import { blockSchemaExtensions } from "./blocks";

/**
 * Version of the shared document schema below, sent by every live editor as the
 * `schema` query parameter on the collab WebSocket (and as the
 * `X-Prism-Editor-Schema` header on REST writes). The server refuses a document
 * socket from an older/unknown version: y-prosemirror DELETES any node or mark
 * its schema cannot represent, so a stale client would silently destroy newer
 * content for everyone.
 *
 * ANY change to a node, mark or attribute name in `collabExtensions()` MUST bump
 * this number (apps/server/test/collab-schema-version.test.ts pins the names).
 *   1 — StarterKit/Link/Highlight/Tasks + suggestion/comment marks (implicit)
 *   2 — + image, table, callout, toggle, columns, block/text colour
 */
export const COLLAB_SCHEMA_VERSION = 2;

/**
 * The document schema shared by the collaborative editor (browser) and the
 * Prism Server's Yjs seeding/persistence (Node). It is the single source of
 * truth for which nodes/marks a collaborative note can contain, so the
 * server's HTML↔Yjs conversion is loss-free against what the client produces.
 *
 * Only *content* extensions live here — no view-only plugins (Placeholder,
 * Collaboration, CollaborationCaret, wikilink decoration) which add no stored
 * schema and don't run in Node. The client appends those; the server doesn't.
 *
 * Mirrors the client config: StarterKit history is off (Yjs owns undo/redo),
 * and StarterKit's bundled Link is disabled in favor of the explicit Link
 * (a duplicate mark corrupts the schema → silent setContent failures).
 */
export function collabExtensions(): Extensions {
  return [
    StarterKit.configure({ undoRedo: false, link: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    Typography,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Images, tables, callouts, toggles, columns and block/text colours —
    // shared with the plain renderer so a note round-trips through either.
    ...blockSchemaExtensions(),
    // Suggested-edit marks (insertion/deletion). Schema-only here so the server
    // can round-trip them through HTML; the suggest-mode behavior plugin is
    // added client-side in CollabEditor.
    ...suggestionMarks(),
    // Comment anchor mark; thread data lives in a Yjs Map (client-side).
    ...commentMarks(),
  ];
}
