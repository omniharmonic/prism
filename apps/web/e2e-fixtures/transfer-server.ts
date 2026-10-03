/**
 * An in-page fake of the Prism Server's import / export routes
 * (`apps/server/src/routes/{import,export}.ts`) for fixture journeys. It runs the
 * SAME pure code the server runs — `planImport`, the ZIP reader/writer, the
 * front-matter writer (`@prism/core` lib/import-export) — over the fixture's
 * note list. What it does not reproduce (and the server tests cover): deflate,
 * HTML → Markdown conversion, permission filtering, quotas and rate limits.
 */
import type { Note } from "@prism/core";
import {
  ASSET_TOKEN,
  ZipWriter,
  attachmentIdsIn,
  looksLikeZip,
  planImport,
  readZipDirectory,
  readZipEntry,
  renderFrontMatter,
  replaceAllLiteral,
  safeFileSegment,
  stripNotionId,
  crc32,
  type ImportFile,
  type ImportPlan,
} from "../../../packages/core/src/lib/import-export/index";
import { isTrashed, isUnder, parentOf } from "../../../packages/core/src/lib/pages/model";

export interface FixtureAttachment { name: string; mime: string; bytes: Uint8Array }
export interface TransferServerOptions {
  notes: Note[];
  stamp: () => string;
  attachments: Map<string, FixtureAttachment>;
  /** Polls a job takes before it finishes (so progress is visible). */
  steps?: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const enc = new TextEncoder();
const hash = (data: string | Uint8Array): string => {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  // Fixture-grade digest: two CRCs (the server uses SHA-256).
  return crc32(bytes).toString(16).padStart(8, "0") + crc32(bytes, 0x9e3779b9).toString(16).padStart(8, "0") + bytes.length.toString(16).padStart(8, "0");
};
const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const encodePath = (p: string) => p.split("/").map((s) => encodeURIComponent(s).split("(").join("%28").split(")").join("%29")).join("/");
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

export function createTransferServer(opts: TransferServerOptions) {
  const { notes, stamp, attachments } = opts;
  const steps = opts.steps ?? 2;
  const requests: Array<Record<string, unknown>> = [];
  const exportJobs = new Map<string, { polls: number; total: number; zip: Uint8Array; name: string; attachments: number; scope: string; format: string; cancelled: boolean }>();
  const importJobs = new Map<string, { polls: number; total: number; result: Record<string, unknown> }>();
  let seq = 0;

  function buildExport(body: { scope: string; noteId?: string; format: string; subpages?: boolean; attachments?: boolean }) {
    const live = notes.filter((n) => !isTrashed(n));
    const root = body.scope === "page" ? live.find((n) => n.id === body.noteId) : undefined;
    if (body.scope === "page" && !root) return null;
    const rows = (root ? [root, ...(body.subpages !== false && root.path ? live.filter((n) => n.id !== root.id && isUnder(n.path, root.path!)) : [])] : live).sort((a, b) => ((a.path ?? "") < (b.path ?? "") ? -1 : 1));
    const base = root?.path ? parentOf(root.path) : "";
    const zip = new ZipWriter();
    const chunks: Uint8Array[] = [];
    const written = new Map<string, string>();
    for (const n of rows) {
      const rel = base && n.path?.startsWith(`${base}/`) ? n.path.slice(base.length + 1) : n.path ?? `_unfiled/${n.id}`;
      const segs = rel.split("/").map((s) => safeFileSegment(s));
      const title = leaf(n.path ?? "Untitled");
      const meta: Record<string, unknown> = { title };
      if (n.tags?.length) meta.tags = n.tags;
      for (const [k, v] of Object.entries(n.metadata ?? {})) if (!k.startsWith("prism_") && !k.startsWith("gov_") && k !== "title" && v != null) meta[k] = v;
      let text = body.format === "html"
        ? `<!doctype html>\n<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'"><title>${title}</title></head>\n<body>\n<h1>${title}</h1>\n${n.content}\n</body></html>\n`
        : `${renderFrontMatter(meta)}# ${title}\n\n${n.content}\n`;
      if (body.attachments !== false) {
        const map = new Map<string, string>();
        for (const id of attachmentIdsIn(text)) {
          const att = attachments.get(id);
          if (!att) continue;
          let name = written.get(id);
          if (!name) {
            const dot = att.name.lastIndexOf(".");
            name = `_attachments/${safeFileSegment(dot > 0 ? att.name.slice(0, dot) : att.name, 60)}-${id.slice(2, 10)}.${EXT[att.mime] ?? "bin"}`;
            chunks.push(zip.add(name, att.bytes));
            written.set(id, name);
          }
          map.set(`/api/attachments/${id}`, `${"../".repeat(segs.length - 1)}${encodePath(name)}`);
        }
        text = replaceAllLiteral(text, map);
      }
      chunks.push(zip.add(`${segs.join("/")}.${body.format === "html" ? "html" : "md"}`, enc.encode(text)));
    }
    chunks.push(zip.add("_export.json", enc.encode(JSON.stringify({ scope: body.scope, format: body.format, pages: rows.length, attachments: written.size, skipped: [] }, null, 2))));
    chunks.push(zip.end());
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    const name = root ? `${safeFileSegment(leaf(root.path ?? "page"))}.zip` : "Personal vault-export-2026-10-01.zip";
    return { zip: out, total: rows.length, name, attachments: written.size };
  }

  function readUpload(bytes: Uint8Array, name: string): { files: ImportFile[]; archive: string; refused: Array<{ entry: string; reason: string }> } {
    const clean = name.split("/").pop() ?? "import";
    const dot = clean.lastIndexOf(".");
    const archive = stripNotionId(dot > 0 ? clean.slice(0, dot) : clean);
    if (!looksLikeZip(bytes)) return { files: [{ name: clean, size: bytes.length, read: () => bytes }], archive, refused: [] };
    const entries = readZipDirectory(bytes, { maxEntries: 5000, maxEntryBytes: 25_000_000, maxTotalBytes: 100_000_000 });
    const refused = entries.filter((e) => e.unsafe).map((e) => ({ entry: e.name, reason: `ignored: ${e.unsafe}` }));
    return { files: entries.filter((e) => !e.directory && !e.unsafe).map((e) => ({ name: e.name, size: e.size, read: () => readZipEntry(bytes, e) })), archive, refused };
  }

  function plan(bytes: Uint8Array, name: string, parent: string) {
    const up = readUpload(bytes, name);
    const p: ImportPlan = planImport(up.files, {
      root: parent,
      htmlToMarkdown: (h) => h,
      allowTag: (t) => (t.startsWith("agent") || t.startsWith("governance") ? null : t.replace(/^[#\s]+/, "").trim()),
      allowKey: (k) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(k) && !k.startsWith("prism_") && !k.startsWith("gov_"),
      hash,
    });
    const byPath = new Map(notes.map((n) => [(n.path ?? "").toLowerCase(), n]));
    const resolved = p.notes.map((note) => {
      const holder = byPath.get(note.path.toLowerCase());
      const stampOf = holder?.metadata?.prism_import as { src?: string; hash?: string } | undefined;
      const action = !holder ? "create" : stampOf?.src === note.src ? (stampOf.hash === note.hash ? "unchanged" : "update") : "conflict";
      return { note, action, holder, ...(action === "conflict" ? { reason: "a page already exists here" } : {}) };
    });
    const count = (a: string) => resolved.filter((r) => r.action === a).length;
    const preview = {
      dryRun: true,
      destination: p.root,
      summary: { pages: p.counts.pages, databases: p.counts.databases, rows: p.counts.rows, attachments: p.counts.assets, links: p.counts.links, create: count("create"), update: count("update"), unchanged: count("unchanged"), conflict: count("conflict"), ignored: p.counts.ignored },
      items: resolved.slice(0, 100).map((r) => ({ path: r.note.path, kind: r.note.kind, action: r.action, ...(r.reason ? { reason: r.reason } : {}) })),
      problems: [...up.refused, ...p.problems],
      // The fixture's "vault/Archive" page is shared with two people (see pages-nav ?shared).
      audience: { sharedPage: parent === "vault/Archive" || parent.startsWith("vault/Archive/"), people: parent.startsWith("vault/Archive") ? 2 : 0, links: 0, workspace: true },
    };
    return { p, resolved, preview };
  }

  function write(planned: ReturnType<typeof plan>, priv = false) {
    const result = { created: 0, updated: 0, unchanged: 0, conflicts: 0, attachments: 0, failed: [] as unknown[], problems: planned.preview.problems, firstId: null as string | null };
    for (const r of planned.resolved) {
      if (r.action === "unchanged") { result.unchanged++; continue; }
      if (r.action === "conflict") { result.conflicts++; continue; }
      let content = r.note.content;
      for (let i = r.note.assets.length - 1; i >= 0; i--) {
        const a = r.note.assets[i]!;
        const file = planned.p.assets.get(a.file);
        const id = `a_${hash(`${r.note.path}:${a.file}`).slice(0, 22).padEnd(22, "0")}`;
        if (file) {
          attachments.set(id, { name: leaf(a.file), mime: a.file.toLowerCase().endsWith(".png") ? "image/png" : "application/octet-stream", bytes: file.read() });
          result.attachments++;
        }
        content = content.split(`(${ASSET_TOKEN}${i})`).join(`(${file ? `/api/attachments/${id}` : a.original})`);
      }
      const metadata = { ...r.note.metadata, ...(priv ? { prism_visibility: "private", prism_creator: "owner@example.test" } : {}), prism_import: { v: 1, src: r.note.src, hash: r.note.hash } };
      if (r.action === "update" && r.holder) {
        Object.assign(r.holder, { content, metadata: { ...r.holder.metadata, ...metadata }, updatedAt: stamp() });
        result.updated++;
        result.firstId ??= r.holder.id;
      } else {
        const note = { id: `imported-${++seq}`, path: r.note.path, content, tags: r.note.tags, metadata, createdAt: stamp(), updatedAt: stamp() } as Note;
        notes.push(note);
        result.created++;
        result.firstId ??= note.id;
      }
    }
    return result;
  }

  async function handle(url: URL, method: string, init?: RequestInit): Promise<Response | null> {
    const path = url.pathname;
    if (path === "/api/export" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ export: body });
      const built = buildExport(body);
      if (!built) return json({ error: "not_found" }, 404);
      const id = `export-job-${++seq}`.padEnd(22, "x").slice(0, 22);
      exportJobs.set(id, { polls: 0, ...built, scope: body.scope, format: body.format, cancelled: false });
      return json({ jobId: id, total: built.total }, 202);
    }
    const ex = path.match(/^\/api\/export\/([^/]+)(\/download)?$/);
    if (ex) {
      const job = exportJobs.get(ex[1]!);
      if (!job) return json({ error: "not_found" }, 404);
      if (method === "DELETE") { job.cancelled = true; requests.push({ cancelExport: ex[1] }); return json({ ok: true }); }
      if (ex[2]) {
        requests.push({ download: ex[1] });
        return new Response(job.zip as BodyInit, { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${job.name}"` } });
      }
      job.polls++;
      const done = job.polls > steps;
      return json({ id: ex[1], state: job.cancelled ? "cancelled" : done ? "done" : "running", scope: job.scope, format: job.format, done: done ? job.total : Math.floor((job.total * job.polls) / (steps + 1)), total: job.total, attachments: done ? job.attachments : 0, skipped: 0, bytes: done ? job.zip.length : 0, fileName: done ? job.name : null, error: null, expiresAt: null });
    }
    if (path === "/api/import" && method === "POST") {
      const headers = new Headers(init?.headers);
      if (headers.get("x-prism-import") !== "1") return json({ error: "csrf_refused" }, 403);
      const raw = init?.body;
      const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : typeof raw === "string" ? enc.encode(raw) : new Uint8Array(raw as ArrayBuffer);
      const dryRun = !(url.searchParams.get("dryRun") === "0");
      const parent = url.searchParams.get("parent") ?? "vault/Imports";
      const priv = url.searchParams.get("private") === "1";
      requests.push({ import: { dryRun, parent, name: url.searchParams.get("name"), bytes: bytes.length, private: priv, confirmShared: url.searchParams.get("confirmShared") === "1" } });
      let planned;
      try {
        planned = plan(bytes, url.searchParams.get("name") ?? "import", parent);
      } catch (e) {
        return json({ error: (e as { code?: string }).code ?? "bad_request", detail: (e as Error).message }, 400);
      }
      if (dryRun) return json(planned.preview);
      if (planned.preview.audience.sharedPage && !priv && url.searchParams.get("confirmShared") !== "1") return json({ error: "confirm_shared" }, 409);
      const id = `import-job-${++seq}`.padEnd(22, "x").slice(0, 22);
      importJobs.set(id, { polls: 0, total: planned.resolved.length, result: write(planned, priv) });
      return json({ jobId: id, preview: { ...planned.preview, dryRun: false } }, 202);
    }
    const im = path.match(/^\/api\/import\/([^/]+)$/);
    if (im) {
      const job = importJobs.get(im[1]!);
      if (!job) return json({ error: "not_found" }, 404);
      if (method === "DELETE") return json({ ok: true });
      job.polls++;
      const done = job.polls > steps;
      const r = job.result as Record<string, any>;
      return json({ id: im[1], state: done ? "done" : "running", destination: "", done: done ? job.total : Math.floor((job.total * job.polls) / (steps + 1)), total: job.total, created: done ? r.created : 0, updated: done ? r.updated : 0, unchanged: done ? r.unchanged : 0, conflicts: done ? r.conflicts : 0, attachments: done ? r.attachments : 0, failed: [], problems: done ? r.problems : [], firstId: done ? r.firstId : null, error: null });
    }
    return null;
  }
  return { handle, requests };
}
