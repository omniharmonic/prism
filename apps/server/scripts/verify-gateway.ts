/**
 * P1 gateway verification. Sets up a view-only capability link scoped to a tag,
 * then asserts the gateway enforces it: anonymous sees nothing, the capability
 * sees only its tag's notes, a forbidden note 403s, and a write is denied at
 * "view". Run with the SAME env as the server: node --env-file=.env --import tsx.
 */
import { addGrant } from "../src/db";
import { signCapability } from "../src/auth/capability";

const BASE = "http://localhost:8787";
const TAG = "19c-philosophy";
const GRANTED_NOTE = "2026-04-23-21-21-05-047018"; // carries TAG
const FORBIDDEN_NOTE = "2026-04-10-21-08-52-167001"; // carries no tags

const capId = `verify-${Date.now()}`;
addGrant({ subject_type: "link", subject: capId, resource_type: "tag", resource: TAG, level: "view", created_by: "verify" });
const cap = signCapability({ id: capId, exp: Date.now() + 3_600_000 });
const t = `?t=${encodeURIComponent(cap)}`;

type R = { status: number; body: any };
async function j(path: string, init?: RequestInit): Promise<R> {
  const r = await fetch(BASE + path, init);
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body };
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

(async () => {
  // --- anonymous (no session, no capability) ---
  const anonNotes = await j("/api/notes");
  check("anon /api/notes → empty (NOT the vault)", anonNotes.status === 200 && Array.isArray(anonNotes.body) && anonNotes.body.length === 0, `status=${anonNotes.status} len=${anonNotes.body?.length}`);

  const anonGet = await j(`/api/notes/${GRANTED_NOTE}`);
  check("anon GET a real note → 403", anonGet.status === 403, `status=${anonGet.status}`);

  const anonMe = await j("/auth/me");
  check("anon /auth/me → 401", anonMe.status === 401, `status=${anonMe.status}`);

  // --- capability: view on tag ---
  const capNotes = await j(`/api/notes${t}`);
  const allTagged = Array.isArray(capNotes.body) && capNotes.body.every((n: any) => (n.tags ?? []).includes(TAG));
  check("cap /api/notes → only tagged notes", capNotes.status === 200 && allTagged && capNotes.body.length === 5, `status=${capNotes.status} len=${capNotes.body?.length} allTagged=${allTagged}`);

  const capGet = await j(`/api/notes/${GRANTED_NOTE}${t}`);
  check("cap GET granted note → 200 + _level=view", capGet.status === 200 && capGet.body?._level === "view", `status=${capGet.status} level=${capGet.body?._level}`);

  const capForbidden = await j(`/api/notes/${FORBIDDEN_NOTE}${t}`);
  check("cap GET untagged note → 403", capForbidden.status === 403, `status=${capForbidden.status}`);

  const capPatch = await j(`/api/notes/${GRANTED_NOTE}${t}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "should be denied" }),
  });
  check("cap PATCH at view-level → 403 (write denied)", capPatch.status === 403, `status=${capPatch.status}`);

  const capPost = await j(`/api/notes${t}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x" }),
  });
  check("cap POST (create) → 403 (owner-only)", capPost.status === 403, `status=${capPost.status}`);

  const capDelete = await j(`/api/notes/${GRANTED_NOTE}${t}`, { method: "DELETE" });
  check("cap DELETE → 403 (owner-only)", capDelete.status === 403, `status=${capDelete.status}`);

  const capTags = await j(`/api/tags${t}`);
  const onlyTag = Array.isArray(capTags.body) && capTags.body.length === 1 && capTags.body[0]?.tag === TAG;
  check("cap /api/tags → only the granted tag", capTags.status === 200 && onlyTag, `status=${capTags.status} tags=${JSON.stringify(capTags.body)}`);

  // --- report ---
  let ok = true;
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${c.name}  [${c.detail}]`);
    if (!c.pass) ok = false;
  }
  console.log(ok ? "\nALL GATEWAY CHECKS PASSED" : "\nFAILURES ABOVE");
  process.exit(ok ? 0 : 1);
})();
