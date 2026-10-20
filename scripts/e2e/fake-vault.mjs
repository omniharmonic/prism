// Minimal in-memory Parachute stand-in for no-vault e2e runs (CI, sandboxes).
// Speaks just enough of the vault REST surface for the governance flows:
// list/create/get/patch/delete notes with tag filtering, /tags, /health.
// Started by scripts/e2e-governance.sh when E2E_FAKE_VAULT=1; NEVER used in
// production — real deployments talk to a real Parachute.
import http from "node:http";

const PORT = Number(process.env.FAKE_VAULT_PORT ?? 8791);
const VAULT = process.env.FAKE_VAULT_NAME ?? "default";
const notes = new Map();
const tags = new Map(); // name → { name, count, description, fields, parent_names }
let seq = 0;

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "bad json" });
      }
      if (url.pathname === "/health") return send(200, { ok: true });
      const api = `/vault/${VAULT}/api`;
      if (url.pathname === `${api}/tags`) return send(200, [...tags.values()]);
      // Tag schema upsert (used by seedTagSchemas) — store description/fields/parent_names.
      const tm = url.pathname.match(new RegExp(`^${api}/tags/(.+)$`));
      if (tm && req.method === "PUT") {
        const name = decodeURIComponent(tm[1]);
        const cur = tags.get(name) ?? { name, count: 0, description: null, fields: null };
        tags.set(name, {
          ...cur,
          description: body.description ?? cur.description,
          fields: body.fields ?? cur.fields,
          ...(body.parent_names ? { parent_names: body.parent_names } : {}),
        });
        return send(200, tags.get(name));
      }
      const m = url.pathname.match(new RegExp(`^${api}/notes(?:/(.+))?$`));
      if (!m) return send(404, { error: "not found" });
      const id = m[1] ? decodeURIComponent(m[1]) : null;

      if (!id && req.method === "GET") {
        const tags = url.searchParams.getAll("tag");
        const search = url.searchParams.get("search");
        let list = [...notes.values()];
        if (tags.length) list = list.filter((n) => tags.every((t) => (n.tags ?? []).includes(t)));
        if (search) list = list.filter((n) => n.content.toLowerCase().includes(search.toLowerCase()));
        return send(200, list.reverse()); // newest first, like the real vault's sort=desc
      }
      if (!id && req.method === "POST") {
        const n = {
          id: `n-${++seq}`,
          content: body.content ?? "",
          path: body.path ?? null,
          metadata: body.metadata ?? null,
          tags: body.tags ?? [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        notes.set(n.id, n);
        return send(200, n);
      }
      const n = id ? notes.get(id) : null;
      if (!n) return send(404, { error: "not found" });
      if (req.method === "GET") return send(200, n);
      if (req.method === "PATCH") {
        if (typeof body.content === "string") n.content = body.content;
        if (body.metadata && typeof body.metadata === "object") n.metadata = body.metadata;
        if (typeof body.path === "string") n.path = body.path;
        const tagsOp = body.tags;
        if (tagsOp && typeof tagsOp === "object" && !Array.isArray(tagsOp)) {
          const set = new Set(n.tags ?? []);
          for (const t of tagsOp.add ?? []) set.add(t);
          for (const t of tagsOp.remove ?? []) set.delete(t);
          n.tags = [...set];
        }
        n.updatedAt = new Date().toISOString();
        return send(200, n);
      }
      if (req.method === "DELETE") {
        notes.delete(id);
        return send(200, { ok: true });
      }
      send(405, { error: "method" });
    });
  })
  .listen(PORT, () => console.log(`[fake-vault] listening on :${PORT} (vault=${VAULT})`));
