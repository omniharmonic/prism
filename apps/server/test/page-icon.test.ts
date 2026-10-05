/**
 * NP-PG-01 — the page icon write rule (`src/page-icon.ts`).
 * A non-owner may set an emoji, a built-in glyph, or an image that is an attachment of
 * THAT page; another page's attachment, a missing one, a non-image file and anything
 * that is not an icon are refused on the gateway PATCH and on the properties route.
 * Through the real gateway app over the fake vault; attachments go through the real upload.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { configureAttachments as configureRaw } from "../src/routes/attachments";
import { resetAttachmentsForTests, setAttachmentStatus, getAttachment } from "../src/attachments";
import { iconWriteRefusal } from "../src/page-icon";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const J = { "content-type": "application/json" };
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetAttachmentsForTests();
  configureRaw({ uploadsPerMinute: 100_000 });
  fv = installFakeVault();
  fv.put({ id: "mine", path: "Docs/Mine", content: "<p>one</p>", tags: ["doc"], metadata: { icon: "🌱" } });
  fv.put({ id: "other", path: "Docs/Other", content: "<p>two</p>", tags: ["doc"] });
  fv.put({ id: "hidden", path: "Private/Hidden", content: "<p>three</p>", tags: [] });
  grantUser(MEMBER, "note", "mine", "edit");
  grantUser(MEMBER, "note", "other", "edit");
});
afterEach(() => { fv.restore(); configureRaw(null); });

const login = (email: string) => sessionCookie(makeSession(email));
async function upload(noteId: string, cookie: string, bytes = PNG, name = "pic.png", kind = "image"): Promise<string> {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), name);
  const r = await api.request(`/notes/${noteId}/attachments?kind=${kind}`, { method: "POST", headers: { cookie, "x-prism-upload": "1" }, body: f });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { url: string }).url;
}
const patch = (id: string, icon: unknown, cookie: string) =>
  api.request(`/notes/${id}`, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ metadata: { icon } }) });
const props = (id: string, icon: unknown, cookie: string) =>
  api.request(`/properties/${id}`, { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ set: { icon } }) });
const iconOf = (id: string) => fv.notes.get(id)!.metadata?.icon;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

for (const [name, write] of [["PATCH /notes/:id", patch], ["POST /properties/:id", props]] as const) {
  test(`${name}: a member sets the page's own uploaded image, an emoji and a built-in icon`, async () => {
    const cookie = login(MEMBER);
    const own = await upload("mine", cookie);
    assert.match(own, /^\/api\/attachments\/a_[A-Za-z0-9_-]{22}$/);
    for (const icon of [own, "📌", "icon:rocket:blue"]) {
      const r = await write("mine", icon, cookie);
      assert.equal(r.status, 200, `${icon}: ${await r.clone().text()}`);
      assert.equal(iconOf("mine"), icon);
    }
    // Restating the stored value and removing the icon always pass.
    assert.equal((await write("mine", "icon:rocket:blue", cookie)).status, 200);
    assert.equal((await write("mine", null, cookie)).status, 200);
    assert.ok(iconOf("mine") === null || iconOf("mine") === undefined);
  });

  test(`${name}: an attachment that is not this page's image is refused, and nothing is written`, async () => {
    const cookie = login(MEMBER);
    const foreign = await upload("other", cookie); // the member can even EDIT the other page
    const ownersFile = await upload("hidden", login(OWNER)); // a page the member cannot see
    const pdf = await upload("mine", cookie, PDF, "doc.pdf", "file"); // this page's, but not an image
    const gone = await upload("mine", cookie);
    setAttachmentStatus(gone.split("/").pop()!, "deleted");
    const missing = `/api/attachments/a_${"Z".repeat(22)}`;
    const answers = new Set<string>();
    for (const icon of [foreign, ownersFile, pdf, gone, missing]) {
      const r = await write("mine", icon, cookie);
      assert.equal(r.status, 403, `${icon}: ${await r.clone().text()}`);
      const body = await json(r);
      assert.equal(body.error, "forbidden");
      answers.add(JSON.stringify(body.reason ?? null));
      assert.equal(iconOf("mine"), "🌱");
    }
    // One answer whatever the reason: no oracle for "that file exists on a page you cannot see".
    assert.equal(answers.size, 1);
    // The same file IS fine on the page that owns it.
    assert.equal((await write("other", foreign, cookie)).status, 200);
    assert.equal(iconOf("other"), foreign);
  });

  test(`${name}: a value that is not an icon is refused`, async () => {
    const cookie = login(MEMBER);
    const own = await upload("mine", cookie);
    for (const icon of ["https://evil.example/x.png", "//evil.example/x.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "/api/notes/hidden", `${own}?x=1`, `${own}/`, `https://prism.example${own}`, "icon:skull:blue", "icon:rocket:chartreuse", "<img src=x>", "x".repeat(33), 7, { src: own }, [own], true]) {
      const r = await write("mine", icon, cookie);
      assert.equal(r.status, 400, `${JSON.stringify(icon)}: ${await r.clone().text()}`);
      assert.equal(iconOf("mine"), "🌱");
    }
  });
}

test("a viewer cannot set an icon at all; an unviewable page answers like a missing one", async () => {
  fv.put({ id: "ro", path: "Docs/Read only", content: "", tags: [] });
  grantUser("viewer@test.local", "note", "ro", "view");
  const cookie = login("viewer@test.local");
  assert.equal((await patch("ro", "📌", cookie)).status, 403);
  assert.equal((await props("ro", "📌", cookie)).status, 403);
  assert.equal((await patch("hidden", "📌", cookie)).status, 404);
  assert.equal((await props("hidden", "📌", cookie)).status, 404);
});

test("create: a new page keeps an icon-shaped value (a duplicate arrives with the source's image) and drops anything else", async () => {
  grantUser(MEMBER, "tag", "doc", "edit");
  const cookie = login(MEMBER);
  const own = await upload("mine", cookie);
  const create = async (path: string, icon: unknown) => {
    const r = await api.request("/notes", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ path, content: "x", tags: ["doc"], metadata: { icon, keep: "yes" } }) });
    assert.ok(r.status === 200 || r.status === 201, `${path}: ${r.status} ${await r.clone().text()}`);
    const made = [...fv.notes.values()].find((n) => n.path === path)!;
    return made.metadata as Record<string, unknown>;
  };
  assert.equal((await create("Docs/Copy one", own)).icon, own);
  assert.equal((await create("Docs/Copy two", "📌")).icon, "📌");
  assert.equal((await create("Docs/Copy three", "icon:leaf:green")).icon, "icon:leaf:green");
  for (const [i, bad] of ["https://evil.example/x.png", "data:image/png;base64,AAAA", "/api/notes/hidden", 7].entries()) {
    const meta = await create(`Docs/Bad ${i}`, bad);
    assert.ok(!("icon" in meta), JSON.stringify(bad));
    assert.equal(meta.keep, "yes");
  }
});

test("the rule itself: vault and note must both match", () => {
  assert.equal(iconWriteRefusal("primary", "n", null, "🌱"), null);
  assert.equal(iconWriteRefusal("primary", "n", "🌱", "🌱"), null);
  assert.equal(iconWriteRefusal("primary", "n", "📌", "🌱"), null);
  assert.equal(iconWriteRefusal("primary", "n", "nope://x", "🌱")?.status, 400);
  assert.equal(iconWriteRefusal("primary", "n", `/api/attachments/a_${"Q".repeat(22)}`, "🌱")?.status, 403);
});

test("an attachment of the page in ANOTHER vault is refused", async () => {
  const cookie = login(MEMBER);
  const own = await upload("mine", cookie);
  const id = own.split("/").pop()!;
  assert.equal(iconWriteRefusal("some-other-vault", "mine", own, "🌱")?.status, 403);
  assert.equal(iconWriteRefusal(resolvedVault(id), "mine", own, "🌱"), null);
});

/** The vault id the upload recorded (the primary vault's registry id in tests). */
function resolvedVault(attachmentId: string): string {
  return getAttachment(attachmentId)!.vault_id;
}
