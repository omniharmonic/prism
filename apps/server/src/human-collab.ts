/** Server-owned, idempotent prose commands for suggest-level humans. */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import { canonicalCollabState, type HumanCollabCommand, type HumanCollabResult } from "@prism/core/collab-commands";
import { FIELD, collabSchema } from "./collab";
import { CollabConflictError, CollabOpError, editFragment, getThread, setThreadResolved, type CollabAuthor } from "./collab-ops";

export const HUMAN_RECEIPTS = "prism-human-command-receipts";
const MAX_AGE = 24 * 60 * 60 * 1000;
const digest = (value: unknown) => createHash("sha256").update(canonicalCollabState(value)).digest("hex");
export function humanRevision(doc: Y.Doc): string {
  const prose = initProseMirrorDoc(doc.getXmlFragment(FIELD), collabSchema()).doc;
  return digest({ doc: prose.toJSON(), comments: doc.getMap("comments").toJSON() });
}
interface Receipt { hash: string; result: HumanCollabResult; at: number }
/** No awaits: caller completes fresh authorization immediately before this. */
export function applyHumanCommand(doc: Y.Doc, command: HumanCollabCommand, author: CollabAuthor & { actorId: string }, now = Date.now()): HumanCollabResult {
  if (command.createdAt > now + 60_000 || command.createdAt < now - MAX_AGE) throw new CollabConflictError("This request expired. Review the current document before preparing a new change.");
  const receipts = doc.getMap<Receipt>(HUMAN_RECEIPTS);
  const key = digest([author.actorId, command.requestId]);
  const hash = digest(command);
  const previous = receipts.get(key);
  if (previous) {
    if (previous.hash !== hash) throw new CollabConflictError("This request ID already describes another change.");
    return previous.result;
  }
  if (humanRevision(doc) !== command.revision) throw new CollabConflictError("The document or comments changed. Your draft is kept; select the current passage and review it before submitting again.");
  const schema = collabSchema();
  const prose = initProseMirrorDoc(doc.getXmlFragment(FIELD), schema).doc;
  const result: HumanCollabResult = {};
  let nextProse = prose;
  let thread: Y.Map<unknown> | undefined;
  if (command.kind === "suggest" || command.kind === "comment") {
    const { from, to, quote = "", text = "" } = command;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from! < 1 || to! < from! || to! >= prose.nodeSize - 1 || !prose.resolve(from!).parent.isTextblock || !prose.resolve(to!).parent.isTextblock) throw new CollabOpError("Select text or a text insertion point in the document.");
    if (prose.textBetween(from!, to!, "\n", "\ufffc") !== quote) throw new CollabConflictError("The selected passage changed. Select it again before submitting.");
    if (command.kind === "suggest") {
      if (from === to && !text) throw new CollabOpError("Enter text to insert or select text to remove.");
      let overlap = false;
      prose.nodesBetween(from!, to!, node => { if (node.marks.some(m => ["insertion", "deletion"].includes(m.type.name))) overlap = true; });
      if (from === to && prose.resolve(from!).marks().some(m => ["insertion", "deletion"].includes(m.type.name))) overlap = true;
      if (overlap) throw new CollabConflictError("This passage already contains a suggestion. Review it before proposing another change here.");
      result.suggestionId = randomUUID();
      const attrs = { user: author.name, color: author.color, actorId: author.actorId, suggestionId: result.suggestionId, turnId: null };
      const tr = new Transform(prose);
      if (from !== to) tr.addMark(from!, to!, schema.marks.deletion!.create(attrs));
      if (text) {
        const marks = prose.resolve(to!).marks().filter(m => !["comment", "insertion", "deletion"].includes(m.type.name));
        const nodes = text.split("\n").flatMap((part, i) => [...(i ? [schema.nodes.hardBreak!.create(null, null, [schema.marks.insertion!.create(attrs)])] : []), ...(part ? [schema.text(part, [...marks, schema.marks.insertion!.create(attrs)])] : [])]);
        tr.insert(to!, nodes);
      }
      nextProse = tr.doc;
    } else {
      if (from === to || !text.trim()) throw new CollabOpError("Select a passage and enter a comment.");
      result.threadId = randomUUID();
      nextProse = new Transform(prose).addMark(from!, to!, schema.marks.comment!.create({ id: result.threadId, resolved: false })).doc;
    }
  } else {
    thread = getThread(doc, command.threadId!);
    if (!thread) throw new CollabConflictError("This comment no longer exists.");
    result.threadId = command.threadId;
    if (command.kind === "reply" && !command.text?.trim()) throw new CollabOpError("Enter a reply.");
  }
  const staleKeys: string[] = [];
  receipts.forEach((receipt, id) => { if (receipt.at < now - MAX_AGE * 2) staleKeys.push(id); });
  if (receipts.size - staleKeys.length >= 5000) throw new CollabOpError("This document has reached its daily collaboration request limit. Try again later.");
  // Persisted state includes ALL roots. Mutation and receipt share one transaction,
  // so reload/lost HTTP acknowledgements cannot apply a command twice.
  doc.transact(() => {
    for (const id of staleKeys) receipts.delete(id);
    if (nextProse !== prose) editFragment(doc, () => nextProse);
    const item = { author: author.name, actorId: author.actorId, color: author.color, text: (command.text ?? "").trim(), createdAt: now, agent: false };
    if (command.kind === "comment") {
      const t = new Y.Map<unknown>();
      t.set("id", result.threadId!); t.set("quote", command.quote!.slice(0, 200)); t.set("resolved", false);
      const comments = new Y.Array(); comments.push([item]); t.set("comments", comments);
      doc.getMap("comments").set(result.threadId!, t);
    } else if (command.kind === "reply") (thread!.get("comments") as Y.Array<unknown>).push([item]);
    else if (command.kind === "resolve") setThreadResolved(doc, command.threadId!, command.resolved!, `human:${author.actorId}`);
    else if (command.kind === "delete-comment") {
      doc.getMap("comments").delete(command.threadId!);
      editFragment(doc, d => {
        const tr = new Transform(d);
        d.descendants((node, pos) => { for (const mark of node.marks) if (mark.type.name === "comment" && mark.attrs.id === command.threadId) tr.removeMark(pos, pos + node.nodeSize, mark); });
        return tr.doc;
      });
    }
    receipts.set(key, { hash, result, at: now });
  }, `human:${author.actorId}`);
  return result;
}
