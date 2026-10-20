/**
 * P1 gateway verification. Sets up a view-only capability link scoped to a tag,
 * then asserts the gateway enforces it: anonymous sees nothing, the capability
 * sees only its tag's notes, a forbidden note 403s, and a write is denied at
 * "view". A third section drives CAPABILITY grants (create / organize / view-less)
 * end to end. Run with the SAME env as the server: node --env-file=.env --import tsx.
 */
import { addGrant, removeGrant, createSession, destroySession } from "../src/db";
import { signCapability } from "../src/auth/capability";
import { randomBytes } from "node:crypto";
import { vault } from "../src/parachute";
import { config } from "../src/config";
import type { Cap } from "../src/permissions";

// Honor the server's configured PORT (.env) instead of hardcoding 8787, so this
// verifies whatever instance you actually started (matches verify-collab-share.ts).
const BASE = `http://localhost:${config.port}`;
// Self-provisioned throwaway fixtures — NO hardcoded vault note IDs, so this
// runs against ANY vault. The gateway section creates GATE_NOTE_COUNT notes
// under TAG plus one untagged note, asserts the capability gateway, then tears
// them all down (along with the cap grant) in the outer finally.
const TAG = "_secgate";
const GATE_NOTE_COUNT = 3;

const capId = `verify-${Date.now()}`;
const capGrant = addGrant({ subject_type: "link", subject: capId, resource_type: "tag", resource: TAG, level: "view", created_by: "verify" });
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
  // --- provision gateway fixtures (throwaway, torn down in the outer finally) ---
  const gateNotes: string[] = [];
  let GRANTED_NOTE = "";
  let FORBIDDEN_NOTE = "";
  try {
    for (let i = 0; i < GATE_NOTE_COUNT; i++) {
      const n = await vault.createNote({ content: `# Gate ${i}\n\ntagged gateway fixture`, path: `_test/secgate/g${i}.md` });
      gateNotes.push(n.id);
      await vault.addTags(n.id, [TAG]);
    }
    GRANTED_NOTE = gateNotes[0]!;
    const forbidden = await vault.createNote({ content: "# Forbidden\n\nuntagged gateway fixture", path: "_test/secgate/forbidden.md" });
    gateNotes.push(forbidden.id);
    FORBIDDEN_NOTE = forbidden.id;

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
  const allOursPresent = Array.isArray(capNotes.body) && gateNotes.slice(0, GATE_NOTE_COUNT).every((id) => capNotes.body.some((n: any) => n.id === id));
  check("cap /api/notes → only tagged notes", capNotes.status === 200 && allTagged && allOursPresent && capNotes.body.length === GATE_NOTE_COUNT, `status=${capNotes.status} len=${capNotes.body?.length} want=${GATE_NOTE_COUNT} allTagged=${allTagged}`);

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

  // ==========================================================================
  // L-Pub-Sec (P3): publishing / federation security gate.
  //
  // Seed two `_secpub` notes (one wikilinks the other AND wikilinks a private,
  // unpublished note) plus one `_secpriv` note. Publish `_secpub` as owner, then
  // assert — as a FULLY ANONYMOUS client (no cookie, no token) — that the public
  // /api/p/* surface exposes ONLY the published set, leaks no vault token, and
  // never lets a private note/node/edge slip through.
  // ==========================================================================
  const PUB_TAG = "_secpub";
  const PRIV_TAG = "_secpriv";
  const PW_TAG = "_secpwpub";
  // Owner Bearer auth for /acl over localhost (desktop owner path in actor.ts).
  const ownerTok = config.collabToken || config.parachuteToken;
  const ownerHdr = { Authorization: `Bearer ${ownerTok}`, "content-type": "application/json" };

  // Raw-text fetch (for token-leak scanning across the whole response body).
  const raw = async (path: string, init?: RequestInit): Promise<{ status: number; text: string }> => {
    const r = await fetch(BASE + path, init);
    return { status: r.status, text: await r.text().catch(() => "") };
  };

  const secNotes: string[] = []; // ids we created — torn down in finally
  let pubSlug = "";
  let pwTagged = false; // did we add PW_TAG to a note (cleanup flag)

  try {
    // --- setup: three throwaway notes via the vault REST API ---
    const priv = await vault.createNote({
      content: "# Secret\n\nprivate body — must never appear in any publication",
      path: "_test/secpub/_secsecret.md",
    });
    secNotes.push(priv.id);
    await vault.addTags(priv.id, [PRIV_TAG]);

    const pageB = await vault.createNote({
      content: "# Sec Page B\n\nin-publication sibling",
      path: "_test/secpub/secpage-b.md",
    });
    secNotes.push(pageB.id);
    await vault.addTags(pageB.id, [PUB_TAG]);

    // Page A links the in-pub sibling ([[secpage-b]]) AND the private note
    // ([[_secsecret]]) — the latter must be filtered out of the graph.
    const pageA = await vault.createNote({
      content: "# Sec Page A\n\nlinks to [[secpage-b]] and the private [[_secsecret]]",
      path: "_test/secpub/secpage-a.md",
    });
    secNotes.push(pageA.id);
    await vault.addTags(pageA.id, [PUB_TAG]);

    // --- publish the tag as owner (end-to-end via /acl, Bearer over localhost) ---
    const pubResp = await j(`/acl/tags/${PUB_TAG}/publish`, {
      method: "POST",
      headers: ownerHdr,
      body: JSON.stringify({ title: "Sec Site" }),
    });
    pubSlug = pubResp.body?.slug ?? "";
    check("owner publish /acl/tags/_secpub/publish → slug", pubResp.status === 200 && !!pubSlug, `status=${pubResp.status} slug=${pubSlug}`);

    // 1. Anon scope: manifest lists ONLY the two _secpub notes; _secpriv absent.
    const manifest = await j(`/api/p/${pubSlug}`);
    const nav: any[] = Array.isArray(manifest.body?.notes) ? manifest.body.notes : [];
    const navIds = nav.map((n) => n.id);
    const onlyPub =
      manifest.status === 200 &&
      nav.length === 2 &&
      navIds.includes(pageA.id) &&
      navIds.includes(pageB.id) &&
      !navIds.includes(priv.id) &&
      nav.every((n) => !(n.tags ?? []).includes(PRIV_TAG));
    check("anon GET /api/p/:slug → manifest lists ONLY _secpub notes (priv absent)", onlyPub, `status=${manifest.status} navIds=${JSON.stringify(navIds)} privId=${priv.id}`);

    // 2. No token leak: no /api/p/* body contains the vault token or an auth echo.
    const bodies = await Promise.all([
      raw(`/api/p/${pubSlug}`),
      raw(`/api/p/${pubSlug}/notes/${pageA.id}`),
      raw(`/api/p/${pubSlug}/graph`),
    ]);
    const leakStrings = [ownerTok, config.parachuteToken, config.collabToken].filter((s) => s && s.length > 8);
    const leaked = bodies.find(
      (b) => leakStrings.some((s) => b.text.includes(s)) || /Bearer\s+ey/i.test(b.text) || /"authorization"/i.test(b.text),
    );
    check("anon /api/p/* → no vault token / Authorization echo in any body", !leaked, leaked ? `leak in body: ${leaked.text.slice(0, 120)}` : "clean (manifest+note+graph)");

    // 3. In-pub note → 200; out-of-pub (private) note → 403.
    const inPub = await j(`/api/p/${pubSlug}/notes/${pageA.id}`);
    check("anon GET /api/p/:slug/notes/<in-pub> → 200", inPub.status === 200 && inPub.body?.id === pageA.id, `status=${inPub.status}`);
    const outPub = await j(`/api/p/${pubSlug}/notes/${priv.id}`);
    check("anon GET /api/p/:slug/notes/<_secpriv> → 403", outPub.status === 403, `status=${outPub.status}`);

    // 4. Graph edge-filtering: no _secpriv node/edge; the in-pub→in-pub edge present.
    const graph = await j(`/api/p/${pubSlug}/graph`);
    const nodes: any[] = Array.isArray(graph.body?.nodes) ? graph.body.nodes : [];
    const edges: any[] = Array.isArray(graph.body?.edges) ? graph.body.edges : [];
    const privNode = nodes.some((n) => n.id === priv.id);
    const privEdge = edges.some((e) => e.source === priv.id || e.target === priv.id);
    const abEdge = edges.some((e) => e.source === pageA.id && e.target === pageB.id);
    check(
      "anon GET /api/p/:slug/graph → no _secpriv node/edge, has in-pub→in-pub edge",
      graph.status === 200 && !privNode && !privEdge && abEdge,
      `status=${graph.status} nodes=${nodes.length} edges=${edges.length} privNode=${privNode} privEdge=${privEdge} abEdge=${abEdge}`,
    );

    // 5. Publishing did NOT open the main gateway: anon /api/notes still empty/blocked.
    const anonNotes2 = await j("/api/notes");
    const gateClosed =
      (anonNotes2.status === 200 && Array.isArray(anonNotes2.body) && anonNotes2.body.length === 0) ||
      anonNotes2.status === 401 ||
      anonNotes2.status === 403;
    check("anon /api/notes after publish → still empty/401/403 (gateway NOT opened)", gateClosed, `status=${anonNotes2.status} len=${anonNotes2.body?.length}`);

    // 6. Password gate (best-effort): publish a tag WITH a password param; only run
    //    the assertion if the server actually honors it (passwordRequired === true).
    await vault.addTags(pageB.id, [PW_TAG]);
    pwTagged = true;
    const pwPub = await j(`/acl/tags/${PW_TAG}/publish`, {
      method: "POST",
      headers: ownerHdr,
      body: JSON.stringify({ title: "PW Site", password: "hunter2" }),
    });
    const pwSlug = pwPub.body?.slug ?? "";
    const pwManifest = pwSlug ? await j(`/api/p/${pwSlug}`) : { status: 0, body: null };
    if (pwManifest.status === 200 && pwManifest.body?.passwordRequired === true) {
      const pwNote = await j(`/api/p/${pwSlug}/notes/${pageB.id}`);
      const navHidden = !Array.isArray(pwManifest.body?.notes) || pwManifest.body.notes.length === 0;
      check("anon password-gated note without unlock cookie → 401 + nav hidden", pwNote.status === 401 && navHidden, `noteStatus=${pwNote.status} navHidden=${navHidden}`);
    } else {
      check("password gate (publish password param) → SKIP (not implemented)", true, `SKIP passwordRequired=${pwManifest.body?.passwordRequired}`);
    }
  } catch (e) {
    check("publishing security section setup", false, `threw: ${(e as Error).message}`);
  } finally {
    // --- teardown: unpublish + delete every _test note; verify nothing remains ---
    try { await j(`/acl/tags/${PW_TAG}/publish`, { method: "DELETE", headers: ownerHdr }); } catch { /* */ }
    try { await j(`/acl/tags/${PUB_TAG}/publish`, { method: "DELETE", headers: ownerHdr }); } catch { /* */ }
    if (pwTagged) for (const id of secNotes) try { await vault.removeTags(id, [PW_TAG]); } catch { /* */ }
    for (const id of secNotes) try { await vault.deleteNote(id); } catch { /* */ }

    // Teardown verification: no _sec* publications and no _sec* notes remain.
    const pubsLeft = await j(`/acl/publications`, { headers: ownerHdr });
    const secPubsLeft = Array.isArray(pubsLeft.body) ? pubsLeft.body.filter((p: any) => String(p.tag ?? "").startsWith("_sec")) : [];
    check("teardown: no _sec* publications remain", pubsLeft.status === 200 && secPubsLeft.length === 0, `left=${JSON.stringify(secPubsLeft.map((p: any) => p.tag))}`);
    let notesLeft = -1;
    try {
      const a = await vault.listNotes({ tags: [PUB_TAG] });
      const b = await vault.listNotes({ tags: [PRIV_TAG] });
      const cc = await vault.listNotes({ tags: [PW_TAG] });
      notesLeft = a.length + b.length + cc.length;
    } catch { /* */ }
    check("teardown: no _sec* notes remain in the vault", notesLeft === 0, `remaining=${notesLeft}`);
  }

  // ==========================================================================
  // Capability grants (P1). A grant may carry an explicit cap list instead of a
  // ladder level, so access composes: "may file notes here but not touch what is
  // already here" (create), "may refile but not rewrite" (organize), and the
  // degenerate drop-box (no `view` at all) which must read NOTHING.
  // ==========================================================================
  const CAPS_TAG = "_seccaps";
  const CAPS_TAG2 = "_seccaps2";
  const capsNotes: string[] = [];
  const capsGrantIds: string[] = [];
  const capsSessions: string[] = [];

  // A real signed-in, non-owner user (caps checks need actor.kind === "user";
  // a capability LINK can never create). Sessions/grants are removed in finally.
  const signIn = (email: string): string => {
    const sid = randomBytes(16).toString("base64url");
    createSession(sid, email, 3_600_000);
    capsSessions.push(sid);
    return `prism_session=${sid}`;
  };
  const withCaps = (email: string, tag: string, caps: Cap[]) => {
    // level is DERIVED from caps by the db (the coherence rule) — pass the
    // weakest value; whatever we pass is overwritten.
    const gr = addGrant({ subject_type: "user", subject: email, resource_type: "tag", resource: tag, level: "view", created_by: "verify", caps });
    capsGrantIds.push(gr.id);
    return gr;
  };
  const asUser = (cookie: string, path: string, init?: RequestInit) =>
    j(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie, "content-type": "application/json" } });

  try {
    // Seed one note in each caps tag, authored by SOMEONE ELSE (no prism_creator
    // for our test users) so creator-based paths can't muddy the assertions.
    const capsNote = await vault.createNote({ content: "# Caps fixture\n\nowned by the owner", path: "_test/seccaps/a.md" });
    capsNotes.push(capsNote.id);
    await vault.addTags(capsNote.id, [CAPS_TAG]);
    const capsNote2 = await vault.createNote({ content: "# Caps fixture 2\n\nto be refiled", path: "_test/seccaps/b.md" });
    capsNotes.push(capsNote2.id);
    await vault.addTags(capsNote2.id, [CAPS_TAG]);

    // --- 1. ["view","create"]: may add notes to the tag, may NOT edit them ---
    const creatorEmail = "verify-caps-create@prism.invalid";
    const creatorGrant = withCaps(creatorEmail, CAPS_TAG, ["view", "create"]);
    check("caps grant stores a coherent, never-inflated level", creatorGrant.level === "view", `level=${creatorGrant.level} caps=${JSON.stringify(creatorGrant.caps)}`);
    const creatorCookie = signIn(creatorEmail);

    const capsPost = await asUser(creatorCookie, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: "# Submitted by a create-cap user", path: "_test/seccaps/c.md", tags: [CAPS_TAG] }),
    });
    if (capsPost.body?.id) capsNotes.push(capsPost.body.id);
    check("caps ['view','create'] → POST /api/notes into the tag → 200", capsPost.status === 200 && !!capsPost.body?.id, `status=${capsPost.status}`);

    const capsPatchDenied = await asUser(creatorCookie, `/api/notes/${capsNote.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "should be denied" }),
    });
    check("caps ['view','create'] → PATCH someone else's note → 403", capsPatchDenied.status === 403, `status=${capsPatchDenied.status}`);

    // --- 2. ["view","organize"]: may retag, may NOT edit content ---
    const orgEmail = "verify-caps-organize@prism.invalid";
    withCaps(orgEmail, CAPS_TAG, ["view", "organize"]);
    withCaps(orgEmail, CAPS_TAG2, ["view", "organize"]); // a legal destination scope
    const orgCookie = signIn(orgEmail);

    const capsRetag = await asUser(orgCookie, `/api/notes/${capsNote2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ add_tags: [CAPS_TAG2] }),
    });
    const retagged = Array.isArray(capsRetag.body?.tags) && capsRetag.body.tags.includes(CAPS_TAG2);
    check("caps ['view','organize'] → PATCH add_tags → 200 + tag applied", capsRetag.status === 200 && retagged, `status=${capsRetag.status} tags=${JSON.stringify(capsRetag.body?.tags)}`);

    const capsUntag = await asUser(orgCookie, `/api/notes/${capsNote2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ remove_tags: [CAPS_TAG2] }),
    });
    const untagged = Array.isArray(capsUntag.body?.tags) && !capsUntag.body.tags.includes(CAPS_TAG2);
    check("caps ['view','organize'] → PATCH remove_tags → 200 + tag removed", capsUntag.status === 200 && untagged, `status=${capsUntag.status} tags=${JSON.stringify(capsUntag.body?.tags)}`);

    const capsContent = await asUser(orgCookie, `/api/notes/${capsNote2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "should be denied" }),
    });
    check("caps ['view','organize'] → PATCH content → 403 (organize is not edit)", capsContent.status === 403, `status=${capsContent.status}`);

    const capsEscalate = await asUser(orgCookie, `/api/notes/${capsNote2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ add_tags: ["_secgate"] }), // a scope they hold nothing on
    });
    check("caps organize → add_tags outside scope → 403 (no retag escalation)", capsEscalate.status === 403, `status=${capsEscalate.status}`);

    // --- 3. a caps grant WITHOUT view reads nothing ---
    const blindEmail = "verify-caps-blind@prism.invalid";
    withCaps(blindEmail, CAPS_TAG, ["create"]);
    const blindCookie = signIn(blindEmail);
    const blindGet = await asUser(blindCookie, `/api/notes/${capsNote.id}`);
    const blindList = await asUser(blindCookie, "/api/notes");
    check(
      "caps without 'view' → GET note 403 and an empty list (no read access)",
      blindGet.status === 403 && blindList.status === 200 && Array.isArray(blindList.body) && blindList.body.length === 0,
      `get=${blindGet.status} listLen=${blindList.body?.length}`,
    );
  } catch (e) {
    check("capability-grants section setup", false, `threw: ${(e as Error).message}`);
  } finally {
    for (const id of capsGrantIds) try { removeGrant(id); } catch { /* */ }
    for (const sid of capsSessions) try { destroySession(sid); } catch { /* */ }
    for (const id of capsNotes) try { await vault.deleteNote(id); } catch { /* */ }
    let capsLeft = -1;
    try {
      capsLeft = (await vault.listNotes({ tags: [CAPS_TAG] })).length + (await vault.listNotes({ tags: [CAPS_TAG2] })).length;
    } catch { /* */ }
    check("teardown: no _seccaps notes remain in the vault", capsLeft === 0, `remaining=${capsLeft}`);
  }

  } finally {
    // --- gateway teardown: remove the cap grant + delete every _secgate note ---
    try { removeGrant(capGrant.id); } catch { /* */ }
    for (const id of gateNotes) try { await vault.deleteNote(id); } catch { /* */ }
    let gateLeft = -1;
    try { gateLeft = (await vault.listNotes({ tags: [TAG] })).length; } catch { /* */ }
    check("teardown: no _secgate notes remain in the vault", gateLeft === 0, `remaining=${gateLeft}`);
  }

  // --- report ---
  let ok = true;
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${c.name}  [${c.detail}]`);
    if (!c.pass) ok = false;
  }
  console.log(ok ? "\nALL GATEWAY CHECKS PASSED" : "\nFAILURES ABOVE");
  process.exit(ok ? 0 : 1);
})();
