/**
 * Import/export — the pure half (`@prism/core/import-export`): the ZIP reader
 * against hostile archives, the linear Markdown scanners, front matter, and the
 * import planner on a Notion-shaped export.
 */
import { threadCpuMs } from "./probe";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  ZipError,
  ZipWriter,
  attachmentIdsIn,
  crc32,
  parseFrontMatter,
  planImport,
  neutralizeUnsafeLinks,
  readZipDirectory,
  readZipEntry,
  renderFrontMatter,
  rewriteMarkdownLinks,
  safeFileSegment,
  safePageSegment,
  safeZipName,
  stripNotionId,
  zipSync,
  type ImportFile,
  type ZipLimits,
} from "@prism/core/import-export";

const LIMITS: ZipLimits = { maxEntries: 100, maxEntryBytes: 1_000_000, maxTotalBytes: 5_000_000 };
const inflate = (d: Uint8Array, max: number) => inflateRawSync(d, { maxOutputLength: Math.max(max, 1) });
const deflate = (d: Uint8Array) => deflateRawSync(d);
const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ZipError ? e.code : `other:${(e as Error).message}`;
  }
  return "ok";
};
/** Patch a little-endian u32 / u16 at the first occurrence of a signature + offset. */
function patch(buf: Uint8Array, sig: number, off: number, value: number, bytes: 2 | 4, nth = 0): Uint8Array {
  const out = Buffer.from(buf);
  let seen = 0;
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out.readUInt32LE(i) === sig && seen++ === nth) {
      if (bytes === 4) out.writeUInt32LE(value >>> 0, i + off);
      else out.writeUInt16LE(value, i + off);
      return out;
    }
  }
  throw new Error("signature not found");
}
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const EOCD = 0x06054b50;

test("zip: round trip (stored + deflated, unicode names) and crc", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const big = "lorem ipsum ".repeat(2000);
  const zip = zipSync([{ name: "Seite/Übersicht.md", data: "# hi" }, { name: "big.md", data: big }], { deflate });
  const entries = readZipDirectory(zip, LIMITS);
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [["Seite/Übersicht.md", 0], ["big.md", 8]]);
  assert.equal(text(readZipEntry(zip, entries[0]!, inflate)), "# hi");
  assert.equal(text(readZipEntry(zip, entries[1]!, inflate)), big);
  assert.ok(zip.length < big.length / 4, "deflated");
});

test("zip slip: absolute, drive-letter, dot-dot, NUL and backslash names are refused, never read", () => {
  for (const bad of ["../evil.md", "a/../../evil.md", "/etc/passwd", "C:\\x.md", "a/./b.md", "a\u0000b.md", "..\\..\\x.md"]) assert.equal(safeZipName(bad), null, bad);
  assert.equal(safeZipName("a\\b//c.md"), "a/b/c.md");
  // An archive carrying such a name: the writer refuses to make one, so hand-patch a name.
  const zip = zipSync([{ name: "aa/evil.md", data: "x" }, { name: "ok.md", data: "y" }]);
  const bytes = Buffer.from(zip);
  // Rewrite BOTH copies of the first name (local + central) to "../evil.md" (same length).
  let at = bytes.indexOf("aa/evil.md");
  while (at !== -1) {
    bytes.write("../evil.md", at, "latin1");
    at = bytes.indexOf("aa/evil.md", at + 1);
  }
  const entries = readZipDirectory(bytes, LIMITS);
  assert.equal(entries[0]!.unsafe, "unsafe path");
  assert.equal(entries[1]!.unsafe, undefined);
  assert.equal(code(() => readZipEntry(bytes, entries[0]!, inflate)), "corrupt");
});

test("zip bombs: entry count, declared sizes, lying sizes, overlapping entries, zip64, encryption", () => {
  const many = zipSync(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.md`, data: "x" })));
  assert.equal(code(() => readZipDirectory(many, { ...LIMITS, maxEntries: 10 })), "too_many_entries");

  const zeros = new Uint8Array(400_000);
  const bomb = zipSync([{ name: "a.bin", data: zeros }, { name: "b.bin", data: zeros }], { deflate });
  assert.ok(bomb.length < 2000);
  assert.equal(code(() => readZipDirectory(bomb, { ...LIMITS, maxEntryBytes: 100_000 })), "too_large");
  assert.equal(code(() => readZipDirectory(bomb, { ...LIMITS, maxTotalBytes: 500_000 })), "too_large");

  // Declared size smaller than the real inflated size: inflate must stop, not allocate.
  const lying = patch(bomb, CEN, 24, 1000, 4);
  const e = readZipDirectory(lying, LIMITS)[0]!;
  assert.equal(e.size, 1000);
  assert.equal(code(() => readZipEntry(lying, e, inflate)), "corrupt");
  // Declared size larger than real: refused too.
  const lying2 = patch(bomb, CEN, 24, 400_001, 4);
  assert.equal(code(() => readZipEntry(lying2, readZipDirectory(lying2, LIMITS)[0]!, inflate)), "corrupt");

  // Overlap: point the second entry's local-header offset at the first entry.
  const overlap = patch(bomb, CEN, 42, 0, 4, 1);
  assert.equal(code(() => readZipDirectory(overlap, LIMITS)), "corrupt");

  assert.equal(code(() => readZipDirectory(patch(many, EOCD, 10, 0xffff, 2), LIMITS)), "unsupported");
  assert.equal(code(() => readZipDirectory(patch(patch(many, EOCD, 10, 0xffff, 2), EOCD, 8, 0xffff, 2), LIMITS)), "unsupported");
  assert.equal(code(() => readZipDirectory(patch(many, CEN, 8, 0x801, 2), LIMITS)), "encrypted");
  assert.equal(code(() => readZipDirectory(patch(many, CEN, 10, 12, 2), LIMITS)), "unsupported"); // bzip2
  assert.equal(code(() => readZipDirectory(patch(many, CEN, 42, 0xfffffff0, 4), LIMITS)), "corrupt");
  assert.equal(code(() => readZipDirectory(Buffer.from("not a zip at all, just text padding"), LIMITS)), "not_zip");
  // A corrupted byte fails the checksum.
  const stored = Buffer.from(zipSync([{ name: "a.md", data: "hello world" }]));
  stored[stored.indexOf("hello")] = 0x48;
  assert.equal(code(() => readZipEntry(stored, readZipDirectory(stored, LIMITS)[0]!, inflate)), "corrupt");
  // The local header is found by signature: a wrong one is refused.
  assert.equal(code(() => readZipDirectory(patch(many, LOC, 0, 0x11111111, 4), LIMITS)), "corrupt");
});

test("zip writer refuses unsafe and duplicate names", () => {
  const w = new ZipWriter();
  w.add("a/b.md", Buffer.from("x"));
  assert.throws(() => w.add("A/B.md", Buffer.from("y")));
  assert.throws(() => w.add("../x.md", Buffer.from("y")));
});

test("names: Notion ids, file and page segments", () => {
  assert.equal(stripNotionId("Plan 0123456789abcdef0123456789abcdef"), "Plan");
  assert.equal(stripNotionId("Plan 0123456789abcdef0123456789abcdeg"), "Plan 0123456789abcdef0123456789abcdeg");
  assert.equal(stripNotionId("0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.equal(safeFileSegment('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(safeFileSegment(".."), "Untitled");
  assert.equal(safeFileSegment("con"), "_con");
  assert.equal(safeFileSegment("evil\u202Efdp.exe"), "evilfdp.exe");
  assert.equal(safePageSegment("a/b\\c"), "a-b-c");
  assert.equal(safePageSegment("agent.md.MD"), "agent");
  assert.equal(safePageSegment("  "), "Untitled");
});

test("markdown links: rewritten outside code, wikilinks and escapes left alone", () => {
  const md = "See [Plan](Plan%20abc.md) and ![pic](img/a.png \"t\") `[no](x.md)`\n```\n[code](x.md)\n```\n[[Wiki|w]] \\[esc](x.md) [ext](https://e.com/a.md)";
  const seen: string[] = [];
  const out = rewriteMarkdownLinks(md, (l) => {
    seen.push(`${l.image ? "!" : ""}${l.text}→${l.target}`);
    return l.target.startsWith("http") ? null : `<${l.target}>`;
  });
  assert.deepEqual(seen, ["Plan→Plan%20abc.md", "!pic→img/a.png", "ext→https://e.com/a.md"]);
  assert.equal(out, "See <Plan%20abc.md> and <img/a.png> `[no](x.md)`\n```\n[code](x.md)\n```\n[[Wiki|w]] \\[esc](x.md) [ext](https://e.com/a.md)");
});

test("the scanners are linear on pathological input", () => {
  const n = 300_000;
  const shapes = ["<x:".repeat(n / 3), "<".repeat(n), "[a]: ".repeat(n / 5), "[".repeat(n), "[ ".repeat(n / 2), "](".repeat(n / 2), "[a](".repeat(n / 4), "[a] ".repeat(n / 4), "`".repeat(n), "[[".repeat(n / 2), "![".repeat(n / 2) + "]", "/api/attachments/a_".repeat(n / 19), "---\n" + "a: [\n".repeat(n / 5)];
  for (const s of shapes) {
    const t0 = threadCpuMs(); // CPU time of this thread (./probe), not the wall clock
    rewriteMarkdownLinks(s, () => "x");
    neutralizeUnsafeLinks(s);
    neutralizeUnsafeLinks(`<a:${s}`);
    attachmentIdsIn(s);
    parseFrontMatter(s);
    stripNotionId(s);
    safePageSegment(s);
    const ms = threadCpuMs() - t0;
    assert.ok(ms < 1500, `${s.slice(0, 8)}… took ${ms} ms`);
  }
});

test("front matter round-trips and cannot be broken out of", () => {
  const data = { title: 'A "quoted": title\n---\nevil: 1', tags: ["a", "b"], count: 3, done: true, nested: { a: [1] }, "bad key": 1, __proto__x: 1 };
  const fm = renderFrontMatter(data);
  assert.equal(fm.split("\n").filter((l) => l === "---").length, 2, "exactly one block");
  const parsed = parseFrontMatter(`${fm}Body\n`);
  assert.equal(parsed.body, "Body\n");
  assert.deepEqual(parsed.data, { title: data.title, tags: ["a", "b"], count: 3, done: true, nested: { a: [1] }, __proto__x: 1 });
  assert.deepEqual(parseFrontMatter("---\ntitle: Plain text\ntags:\n  - x\n  - y\n__proto__: {\"a\":1}\n---\nB").data, { title: "Plain text", tags: ["x", "y"] });
  assert.deepEqual(parseFrontMatter("no front matter").data, {});
  assert.deepEqual(parseFrontMatter("---\nnever closed\n").body, "---\nnever closed\n");
});

test("attachment ids: exact shape only", () => {
  const id = "a_0123456789abcdefghijAB";
  assert.deepEqual(attachmentIdsIn(`<img src="/api/attachments/${id}"> ![x](/api/attachments/${id}) /api/attachments/a_short /api/attachments/${id}extra`), [id]);
});

const NID = (n: number) => String(n).padStart(32, "0");
function notionExport(): ImportFile[] {
  const f = (name: string, data: string | Uint8Array): ImportFile => {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    return { name, size: bytes.length, read: () => bytes };
  };
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  return [
    f(`Home ${NID(1)}.md`, `# Home\n\nSee [Plan](Home%20${NID(1)}/Plan%20${NID(2)}.md) and [Reading](Home%20${NID(1)}/Reading%20list%20${NID(3)}.csv).\n\n![diagram](Home%20${NID(1)}/diagram.png)\n\n[ext](https://example.com)`),
    f(`Home ${NID(1)}/Plan ${NID(2)}.md`, `# Plan\n\nBack to [the start](../Home%20${NID(1)}.md).\n\n\`\`\`\n[not](a.md)\n\`\`\`\n`),
    f(`Home ${NID(1)}/diagram.png`, PNG),
    f(`Home ${NID(1)}/unused.png`, PNG),
    f(`Home ${NID(1)}/Reading list ${NID(3)}.csv`, "Name,Status,Pages,prism_visibility\nDune,Done,412,private\nEmma,Reading,,\n"),
    f(`Home ${NID(1)}/Reading list ${NID(3)}_all.csv`, "Name,Status\nDune,Done\n"),
    f(`Home ${NID(1)}/Reading list ${NID(3)}/Dune ${NID(4)}.md`, "# Dune\n\nStatus: Done\nPages: 412\n\nA desert planet.\n"),
    f(`__MACOSX/._Home`, "junk"),
    f(`Home ${NID(1)}/.DS_Store`, "junk"),
  ];
}
const planOpts = (root = "vault/Imports/N") => ({
  root,
  htmlToMarkdown: (h: string) => h,
  allowTag: (t: string) => (t.startsWith("agent") ? null : t.trim()),
  allowKey: (k: string) => /^[a-z][a-z0-9_]*$/.test(k) && !k.startsWith("prism_"),
  hash: sha,
});

test("planner: a Notion export keeps nesting, strips ids, links pages, maps the CSV to a database", () => {
  const plan = planImport(notionExport(), planOpts());
  assert.deepEqual(plan.notes.map((n) => [n.kind, n.path]), [
    ["page", "vault/Imports/N/Home"],
    ["page", "vault/Imports/N/Home/Plan"],
    ["database", "vault/Imports/N/Home/Reading list"],
    ["row", "vault/Imports/N/Home/Reading list/Dune"],
    ["row", "vault/Imports/N/Home/Reading list/Emma"],
  ]);
  const [home, planPage, db, dune, emma] = plan.notes;
  assert.equal(home!.content, "See [[vault/Imports/N/Home/Plan]] and [[vault/Imports/N/Home/Reading list|Reading]].\n\n![diagram](prism-import-asset:0)\n\n[ext](https://example.com)");
  assert.deepEqual(home!.assets.map((a) => [a.file, a.image]), [[`Home ${NID(1)}/diagram.png`, true]]);
  assert.equal(planPage!.content, "Back to [[vault/Imports/N/Home|the start]].\n\n```\n[not](a.md)\n```\n");
  const tag = (db!.metadata.prism_database as { source: { tags: string[] } }).source.tags[0]!;
  assert.match(tag, /^db-reading-list-[0-9a-f]{8}$/);
  assert.equal(db!.metadata.prism_type, "database");
  assert.deepEqual((db!.metadata.prism_database as { views: Array<{ visible: string[] }> }).views[0]!.visible, ["status", "pages", "col_prism_visibility"]);
  assert.deepEqual(db!.tags, [], "the database page is not one of its own rows");
  assert.deepEqual([dune!.tags, dune!.metadata, dune!.content], [[tag], { title: "Dune", status: "Done", pages: "412", col_prism_visibility: "private" }, "A desert planet.\n"]);
  assert.deepEqual([emma!.metadata, emma!.content], [{ title: "Emma", status: "Reading" }, ""]);
  assert.deepEqual(plan.counts, { pages: 2, databases: 1, rows: 2, assets: 1, links: 3, ignored: 4 });
  assert.deepEqual([...plan.assets.keys()], [`Home ${NID(1)}/diagram.png`]);
  // Deterministic: the same upload plans the same notes, hashes and source keys.
  const again = planImport(notionExport(), planOpts());
  assert.deepEqual(again.notes.map((n) => [n.src, n.hash]), plan.notes.map((n) => [n.src, n.hash]));
  // A different destination changes paths (and the database tag), not the source identity.
  const moved = planImport(notionExport(), planOpts("vault/Other"));
  assert.deepEqual(moved.notes.map((n) => n.src), plan.notes.map((n) => n.src));
  assert.notEqual((moved.notes[2]!.metadata.prism_database as { source: { tags: string[] } }).source.tags[0], tag);
});

test("planner: front matter → tags and properties through the allow rules; collisions; limits", () => {
  const f = (name: string, data: string): ImportFile => ({ name, size: Buffer.byteLength(data), read: () => Buffer.from(data) });
  const plan = planImport(
    [
      f("wrap/A.md", '---\ntitle: "A"\ntags: ["ok", "agent-skill", "#hash"]\nstatus: "draft"\nprism_creator: "x@y"\nBad-Key: 1\n---\n\n# A\n\nBody'),
      f("wrap/a.md", "second"),
      f("wrap/b.html", "<p>html</p>"),
      f("wrap/big.md", "x".repeat(5000)),
      f("wrap/deep/1/2/3/4/c.md", "deep"),
    ],
    { ...planOpts("vault/R"), limits: { maxTextBytes: 4000, maxDepth: 6 } },
  );
  assert.deepEqual(plan.notes.map((n) => n.path), ["vault/R/A", "vault/R/a (2)", "vault/R/b"]);
  assert.deepEqual([plan.notes[0]!.tags, plan.notes[0]!.metadata, plan.notes[0]!.content], [["ok", "#hash"], { status: "draft" }, "Body"]);
  assert.deepEqual(plan.problems.map((p) => p.reason).sort(), ["skipped: nested too deeply", "skipped: the page is too large", "tag not applied: agent-skill"]);
  // The note cap.
  const many = planImport(Array.from({ length: 8 }, (_, i) => f(`p${i}.md`, "x")), { ...planOpts(), limits: { maxNotes: 5 } });
  assert.equal(many.notes.length, 5);
  assert.equal(many.problems.length, 3);
});

// ── template variables (NP-TX-02; packages/core/src/lib/pages/templates.ts) ──
import { applyTemplateVariables, resolveTemplateContent, resolveTemplateMetadata, templateCreator } from "../../../packages/core/src/lib/pages/templates";

test("template variables: body (HTML chips / Markdown text), properties, and what is NOT a variable", () => {
  const now = new Date(2026, 9, 3, 15, 30, 0);
  let n = 0;
  const ctx = { now, creator: "Ada <Park>", uid: () => `uid${++n}` };
  const html = resolveTemplateContent('<h2>Log @today</h2><p title="@today">At @Now by @me, @creator.</p><pre>@today</pre><p><code>@now</code> me@today.io @todayish x@me <span data-type="mention" data-kind="date" data-date="2026-01-01">@2026-01-01</span> @today</p>', ctx);
  assert.equal(
    html,
    `<h2>Log <span data-type="mention" data-kind="date" data-date="2026-10-03" data-mention-uid="uid1">@2026-10-03</span></h2>` +
      `<p title="@today">At <span data-type="mention" data-kind="date" data-date="${now.toISOString()}" data-mention-uid="uid2">@${now.toISOString().slice(0, 10)}</span> by Ada &lt;Park&gt;, Ada &lt;Park&gt;.</p><pre>@today</pre>` +
      `<p><code>@now</code> me@today.io @todayish x@me <span data-type="mention" data-kind="date" data-date="2026-01-01">@2026-01-01</span> <span data-type="mention" data-kind="date" data-date="2026-10-03" data-mention-uid="uid3">@2026-10-03</span></p>`,
  );
  const md = resolveTemplateContent("# @today\n\nBy @me. `@today` [[Notes @today]] mail a@now.co\n```\n@today\n```\n@now", ctx);
  const day = now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  assert.ok(md.startsWith(`# ${day}\n\nBy Ada <Park>. \`@today\` [[Notes @today]] mail a@now.co\n\`\`\`\n@today\n\`\`\`\n${day} `), md);
  assert.deepEqual(resolveTemplateMetadata({ due: "@today", at: " @NOW ", who: "@me", list: ["@today", "x"], note: "see @today", n: 3 }, ctx), { due: "2026-10-03", at: now.toISOString(), who: "Ada <Park>", list: ["2026-10-03", "x"], note: "see @today", n: 3 });
  // No creator known: @me stays as written; the title is never rewritten.
  assert.equal(resolveTemplateContent("By @me", { now }), "By @me");
  assert.deepEqual(applyTemplateVariables({ content: "x", path: "p", metadata: { title: "@today", due: "@today" } }, ctx).metadata, { title: "@today", due: "2026-10-03" });
  // Linear on hostile templates.
  const t0 = threadCpuMs(); // CPU time of this thread (./probe), not the wall clock
  for (const s of ["@".repeat(200_000), "<".repeat(200_000), "@today".repeat(40_000), "<p>" + "@me ".repeat(50_000), "`@".repeat(100_000), "[[@".repeat(70_000)]) resolveTemplateContent(s, ctx);
  assert.ok(threadCpuMs() - t0 < 2000);
});

test("template creator: the account's display name, else a neutral Me — never the e-mail", async () => {
  const res = (body: unknown, ok = true) => async () => ({ ok, json: async () => body }) as Response;
  assert.equal(await templateCreator(res({ name: " Ada ", email: "a@x.co" })), "Ada");
  // Never the account's address: a neutral "Me" when there is no display name.
  assert.equal(await templateCreator(res({ name: null, email: "a@x.co" })), "Me");
  assert.equal(await templateCreator(res({ name: "a@x.co", email: "a@x.co" })), "Me");
  assert.equal(await templateCreator(res({ authenticated: false })), null);
  assert.equal(await templateCreator(res({}, false)), null);
  assert.equal(await templateCreator(async () => { throw new Error("offline"); }), null);
});
