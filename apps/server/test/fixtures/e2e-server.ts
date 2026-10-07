/**
 * A REAL Prism Server for browser fixture journeys (wave 2D) — the actual app,
 * gateway, collab socket and human-command endpoint, over the in-memory fake
 * vault and an in-memory SQLite DB. Never touches a real vault or the live DB.
 *
 *   cd apps/server && APP_ORIGIN=http://127.0.0.1:5198 \
 *     node --import tsx --env-file=.env.test test/fixtures/e2e-server.ts
 *
 * Prints ONE JSON line on stdout once listening:
 *   { port, sessions: { owner, sam, eve, gina }, notes: {...} }
 * and exits when stdin closes (the Playwright spec owns its lifetime).
 *
 * Seed (fictional):
 *   vault/Shared/Plan            "plan"   prose; sam = suggest (page share), eve = edit
 *   vault/Shared/Plan/Notes      "notes"  sub-page of the shared page
 *   vault/Shared/Rich            "rich"   rich prose for revision parity; sam = suggest
 *   vault/Shared/Bomb            "bomb"   content the live editor cannot convert; eve = edit, sam = view
 *   vault/Private/Budget         "secret" nobody but the owner
 *   gina: a guest with ONE page share ("plan", view) and nothing else
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "../../src/app";
import { attachCollab } from "../../src/collab";
import { configureConversion } from "../../src/convert/service";
import { addGrant, setAccount, setUserProfile } from "../../src/db";
import { installFakeVault, makeSession } from "../helpers";
import { resetTreeForTests } from "../../src/tree";

const fv = installFakeVault();
const OWNER = "owner@test.local";
const SAM = "sam@test.local";
const EVE = "eve@test.local";
const GINA = "gina@test.local";

const RICH =
  "<h2>Purpose</h2>" +
  "<p>We collect <strong>notes</strong>, <em>tasks</em> and <u>sources</u> — in one place ✓ 日本語.</p>" +
  '<p>Read the <a href="https://example.test/guide">guide</a> and <mark data-color="#fef08a" style="background-color: #fef08a; color: inherit">highlight</mark> it.</p>' +
  "<ul><li><p>First item</p></li><li><p>Second item</p></li></ul>" +
  "<ol><li><p>One</p></li></ol>" +
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done task</p></div></li></ul>' +
  "<blockquote><p>A quoted line.</p></blockquote>" +
  "<pre><code>const x = 1;</code></pre>" +
  "<hr>" +
  "<p>Line one<br>line two and [[Some Page]].</p>";

fv.put({ id: "plan", path: "vault/Shared/Plan", content: "<p>Alpha beta gamma</p><p>Second paragraph here.</p>", metadata: { prism_creator: OWNER }, tags: ["team"] });
fv.put({ id: "notes", path: "vault/Shared/Plan/Notes", content: "<p>Child notes about the plan.</p>", tags: ["team"] });
fv.put({ id: "rich", path: "vault/Shared/Rich", content: RICH, tags: ["team"] });
fv.put({ id: "blank", path: "vault/Shared/Blank", content: "" }); // an empty page: sam = suggest (note share)
// A page whose body no parser can take (a blockquote 300 deep: refused by the conversion
// pre-check, deterministically and at once) — the live editor is refused `too_complex`.
fv.put({ id: "bomb", path: "vault/Shared/Bomb", content: `${"> ".repeat(300)}deep words`, tags: ["team"] });
fv.put({ id: "secret", path: "vault/Private/Budget", content: "<p>Fictional budget for the plan.</p>", tags: ["team"] });

for (const [email, name] of [[SAM, "Sam Chen"], [EVE, "Eve Editor"], [GINA, "Gina Guest"]] as const) {
  setAccount(email, email, "hash");
  setUserProfile(email, { name });
}
setUserProfile(OWNER, { name: "Olive Owner" });
const grant = (subject: string, resource_type: "page" | "note", resource: string, level: "view" | "suggest" | "edit") =>
  addGrant({ subject_type: "user", subject, resource_type, resource, level, created_by: OWNER });
grant(SAM, "page", "plan", "suggest");
grant(SAM, "note", "rich", "suggest");
grant(SAM, "note", "blank", "suggest");
grant(EVE, "page", "plan", "edit");
grant(EVE, "note", "rich", "edit");
grant(EVE, "note", "bomb", "edit");
grant(SAM, "note", "bomb", "view");
grant(GINA, "page", "plan", "view");

const app = createApp();
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
  process.stdout.write(
    JSON.stringify({
      port: info.port,
      sessions: { owner: makeSession(OWNER), sam: makeSession(SAM), eve: makeSession(EVE), gina: makeSession(GINA) },
    }) + "\n",
  );
});
attachCollab(server as unknown as Server);

// Test hooks over stdin: one JSON command per line → one JSON line back.
let restoreLimits: (() => void) | null = null;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      const cmd = JSON.parse(line) as { op: string; id?: string; content?: string; limits?: Parameters<typeof configureConversion>[0] | null };
      if (cmd.op === "note") {
        const n = fv.notes.get(cmd.id ?? "");
        process.stdout.write(JSON.stringify({ op: "note", note: n ?? null }) + "\n");
      } else if (cmd.op === "put") {
        // An external writer replaces a note's body (a newer version).
        const n = fv.notes.get(cmd.id ?? "");
        if (n) fv.put({ ...n, content: cmd.content ?? "", updatedAt: new Date().toISOString() });
        process.stdout.write(JSON.stringify({ op: "put", ok: !!n }) + "\n");
      } else if (cmd.op === "add") {
        // A spec seeds a note of its own (never one of the notes above): other specs' seed is untouched.
        const note = (cmd as unknown as { note?: Parameters<typeof fv.put>[0] }).note;
        const fresh = !!note && typeof note.id === "string" && !fv.notes.has(note.id);
        if (fresh) {
          fv.put(note!);
          // The tree projection has no vault socket here (TREE_SUBSCRIBE=0): rebuild it on the next
          // read so a note seeded behind the gateway's back is listed like any other.
          resetTreeForTests();
        }
        process.stdout.write(JSON.stringify({ op: "add", ok: fresh }) + "\n");
      } else if (cmd.op === "limits") {
        // Change the conversion limits (e.g. so nothing can be rendered for the vault: a page "too large to save"); null restores them.
        restoreLimits?.();
        restoreLimits = cmd.limits ? configureConversion(cmd.limits) : null;
        process.stdout.write(JSON.stringify({ op: "limits", ok: true }) + "\n");
      } else if (cmd.op === "patches") {
        const calls = fv.calls.filter((c) => c.method === "PATCH" && c.path.includes(cmd.id ?? "")).length;
        process.stdout.write(JSON.stringify({ op: "patches", count: calls }) + "\n");
      }
    } catch {
      process.stdout.write(JSON.stringify({ op: "error" }) + "\n");
    }
  }
});
process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});
