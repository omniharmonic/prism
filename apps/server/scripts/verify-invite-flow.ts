/**
 * Invite → account → login → shared-edit sanity check. Drives the full
 * invite-only-with-passwords flow against the RUNNING server (localhost:8787),
 * end to end, WITHOUT email — Resend may be down, so we mint the invite token
 * in-process (createInvite returns the accept URL, same fn the /acl route calls)
 * and then exercise the real HTTP register/login/gateway endpoints.
 *
 * Proves, for a brand-new person the owner shares one note with:
 *   1. owner share-by-email auto-issues an invite (PUT /acl/.../people → invited)
 *   2. the invite token registers a password account (POST /auth/register)
 *   3. registration logs them in; /auth/me sees a non-owner with a password
 *   4. the gateway shows ONLY the shared note (and 403s a non-shared one)
 *   5. email + password login works on its own (POST /auth/login)
 *   6. collab authorizes that signed-in guest to EDIT the shared doc
 *
 * Self-cleaning: a fixed test email's rows (grant/invite/session/user) are purged
 * before and after, so the vault/DB are left exactly as found. The note grant is
 * by id and never mutates the note's content.
 *
 *   Run:  node --env-file=.env --import tsx scripts/verify-invite-flow.ts
 */
import { config } from "../src/config";
import { authorizeConnection } from "../src/collab";
import { db } from "../src/db";
import { vault } from "../src/parachute";

// Honor the server's configured PORT (.env), not a hardcoded 8787, so this drives
// whatever instance is actually running (matches verify-collab-share.ts).
const BASE = `http://localhost:${config.port}`;
// Self-provisioned throwaway fixtures (no hardcoded vault IDs — runs on any vault):
// one note we share with the test user, one that carries no grant (must stay
// forbidden). Both are created at startup and deleted in the finally block.
let SHARED_NOTE = "";
let FORBIDDEN_NOTE = "";

const TEST_EMAIL = "invite-e2e@prism.test";
const TEST_NAME = "Invite E2E";
const TEST_PW = "prism-e2e-Passw0rd!";

const OWNER_BEARER = config.collabToken || config.parachuteToken;
const ownerHeaders = { authorization: `Bearer ${OWNER_BEARER}`, "content-type": "application/json" };

type R = { status: number; body: any; setCookie: string | null };
async function req(path: string, init?: RequestInit): Promise<R> {
  const r = await fetch(BASE + path, init);
  let body: any = null;
  try { body = await r.json(); } catch { /* non-json (e.g. 204) */ }
  return { status: r.status, body, setCookie: sessionCookie(r) };
}

/** Pull `prism_session=<id>` out of a response's Set-Cookie, if present. */
function sessionCookie(r: Response): string | null {
  const list: string[] =
    (r.headers as any).getSetCookie?.() ?? [r.headers.get("set-cookie")].filter(Boolean);
  for (const c of list) {
    const m = /prism_session=([^;]+)/.exec(c);
    if (m) return `prism_session=${m[1]}`;
  }
  return null;
}

/** Remove all rows for the test identity, so the DB is left as found. */
function purge(email: string): void {
  db.prepare("DELETE FROM grants WHERE subject = ?").run(email);
  db.prepare("DELETE FROM invites WHERE email = ?").run(email);
  db.prepare("DELETE FROM sessions WHERE email = ?").run(email);
  db.prepare("DELETE FROM users WHERE email = ?").run(email);
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });

(async () => {
  if (!OWNER_BEARER) {
    console.error("No COLLAB_TOKEN/PARACHUTE_TOKEN in env — run with --env-file=.env");
    process.exit(2);
  }
  if (TEST_EMAIL === config.ownerEmail) {
    console.error("TEST_EMAIL collides with OWNER_EMAIL — abort");
    process.exit(2);
  }

  purge(TEST_EMAIL); // start clean

  // Provision throwaway fixtures: a note to share + an unshared "forbidden" note.
  const shared = await vault.createNote({
    content: "# Invite E2E — Shared\n\nThis note is shared with the test user.",
    path: "_test/invite/shared.md",
  });
  const forbidden = await vault.createNote({
    content: "# Invite E2E — Forbidden\n\nThis note is NOT shared and must 403.",
    path: "_test/invite/forbidden.md",
  });
  SHARED_NOTE = shared.id;
  FORBIDDEN_NOTE = forbidden.id;

  try {
    // 1. Owner shares the note by email → should auto-invite (no account yet).
    const grant = await req(`/acl/notes/${SHARED_NOTE}/people`, {
      method: "PUT",
      headers: ownerHeaders,
      body: JSON.stringify({ email: TEST_EMAIL, level: "edit" }),
    });
    check(
      "owner PUT /acl/.../people → 200 + invited:true + inviteUrl",
      grant.status === 200 && grant.body?.invited === true && typeof grant.body?.inviteUrl === "string",
      `status=${grant.status} body=${JSON.stringify(grant.body)}`,
    );

    // Use the accept URL the API just handed back (email is down; this is the
    // "copy invite link" the owner would send) — fully HTTP, no in-process mint.
    const token = grant.body?.inviteUrl ? (new URL(grant.body.inviteUrl).searchParams.get("token") ?? "") : "";
    check("invite token recovered from API response", !!token);

    // 2. The registration screen can peek at the invite (shows the email).
    const peek = await req(`/auth/invite-info?token=${encodeURIComponent(token)}`);
    check(
      "GET /auth/invite-info → valid + correct email",
      peek.status === 200 && peek.body?.valid === true && peek.body?.email === TEST_EMAIL,
      `status=${peek.status} body=${JSON.stringify(peek.body)}`,
    );

    // 3. Register an account from the invite — should also log them in.
    const reg = await req("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: TEST_NAME, password: TEST_PW }),
    });
    check(
      "POST /auth/register → 200 + session cookie set",
      reg.status === 200 && reg.body?.ok === true && !!reg.setCookie,
      `status=${reg.status} cookie=${!!reg.setCookie}`,
    );
    const regCookie = reg.setCookie ?? "";

    // Single-use: the same token must not register a second account.
    const regAgain = await req("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "Dupe", password: TEST_PW }),
    });
    check("invite is single-use → second register 400", regAgain.status === 400, `status=${regAgain.status}`);

    // 4. /auth/me sees a signed-in NON-owner with a password.
    const me = await req("/auth/me", { headers: { cookie: regCookie } });
    check(
      "GET /auth/me (post-register) → non-owner, hasPassword",
      me.status === 200 && me.body?.authenticated === true && me.body?.isOwner === false && me.body?.hasPassword === true,
      `status=${me.status} body=${JSON.stringify(me.body)}`,
    );

    // 5. Gateway shows ONLY the shared note — not the whole vault.
    const notes = await req("/api/notes", { headers: { cookie: regCookie } });
    const ids: string[] = Array.isArray(notes.body) ? notes.body.map((n: any) => n.id) : [];
    check(
      "GET /api/notes → contains the shared note, scoped (not the vault)",
      notes.status === 200 && ids.includes(SHARED_NOTE) && !ids.includes(FORBIDDEN_NOTE) && ids.length < 100,
      `status=${notes.status} count=${ids.length} hasShared=${ids.includes(SHARED_NOTE)} hasForbidden=${ids.includes(FORBIDDEN_NOTE)}`,
    );

    const getShared = await req(`/api/notes/${SHARED_NOTE}`, { headers: { cookie: regCookie } });
    check(
      "GET shared note → 200 + _level=edit",
      getShared.status === 200 && getShared.body?._level === "edit",
      `status=${getShared.status} level=${getShared.body?._level}`,
    );

    const getForbidden = await req(`/api/notes/${FORBIDDEN_NOTE}`, { headers: { cookie: regCookie } });
    check("GET a non-shared note → 403", getForbidden.status === 403, `status=${getForbidden.status}`);

    // 6. Email + password login works on its own (fresh session).
    const login = await req("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PW }),
    });
    check(
      "POST /auth/login → 200 + fresh session cookie",
      login.status === 200 && login.body?.ok === true && !!login.setCookie,
      `status=${login.status} cookie=${!!login.setCookie}`,
    );
    const loginCookie = login.setCookie ?? "";

    const badLogin = await req("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: "wrong-password" }),
    });
    check("wrong password → 401", badLogin.status === 401, `status=${badLogin.status}`);

    const meAfterLogin = await req("/auth/me", { headers: { cookie: loginCookie } });
    check(
      "GET /auth/me (post-login) → authenticated",
      meAfterLogin.status === 200 && meAfterLogin.body?.authenticated === true,
      `status=${meAfterLogin.status}`,
    );

    // 7. Collab authorizes the signed-in guest to EDIT the shared doc.
    const connCfg = { readOnly: false };
    let collabLevel: string | null = null;
    try {
      collabLevel = await authorizeConnection(SHARED_NOTE, "", loginCookie, connCfg, false);
    } catch (e) {
      collabLevel = `THREW: ${(e as Error).message}`;
    }
    check(
      "collab authorizeConnection (shared doc) → edit, not read-only",
      collabLevel === "edit" && connCfg.readOnly === false,
      `level=${collabLevel} readOnly=${connCfg.readOnly}`,
    );

    // Collab must reject the guest on a note they were never granted.
    let forbiddenThrew = false;
    try {
      await authorizeConnection(FORBIDDEN_NOTE, "", loginCookie, { readOnly: false }, false);
    } catch {
      forbiddenThrew = true;
    }
    check("collab on a non-shared doc → rejected", forbiddenThrew);
  } finally {
    purge(TEST_EMAIL); // leave the DB as we found it
    // Delete the throwaway fixtures so the vault is left exactly as found.
    for (const id of [SHARED_NOTE, FORBIDDEN_NOTE]) {
      if (id) { try { await vault.deleteNote(id); } catch { /* best-effort */ } }
    }
  }

  let ok = true;
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
    if (!c.pass) ok = false;
  }
  console.log(ok ? "\nALL INVITE-FLOW CHECKS PASSED" : "\nFAILURES ABOVE");
  process.exit(ok ? 0 : 1);
})();
