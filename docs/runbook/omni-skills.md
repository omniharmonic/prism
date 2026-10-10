# Omni installed-skills editor

This exposes existing `SKILL.md` documents to the authenticated server owner. It does not
install skills, execute their contents, create arbitrary files, or change other files in a
skill folder. Settings → Agent → Skills lists the installed documents and opens a text
editor for local files. Linked repository sources are read-only.

## Configuration and activation

The default is unavailable (`503 skills_not_configured`). Set the server environment to
an explicit absolute skills directory, then use the normal reviewed server deployment /
restart procedure. Never accept these roots from a client request.

For the current Mini installation, the reviewed values are:

```text
OMNI_SKILLS_DIR=/Users/benjaminlife/.hermes/skills
OMNI_SKILLS_READ_ROOTS=/Users/benjaminlife/.agents/skills
```

`OMNI_SKILLS_READ_ROOTS` is an optional platform-path-delimited list of trusted **read**
roots. The two installed links to `agent-browser` and `find-skills` may be read under this
root, but never edited through Omni. Without an explicit readable root their locations
and read-only explanation are shown, without reading their contents. The main root is
canonicalized; linked ancestor folders or final files are never writable.

After deploying, verify the authenticated owner receives the expected catalog (the
current Mini catalog has 54 active documents: 52 local files and two linked sources;
55 archived documents under `.archive` are intentionally excluded), a linked entry is read-only, and a local skill
loads. An edit is an intentional owner action: choose a disposable local skill only if a
live save test is explicitly authorized, preserve its original bytes and restore them.
Offline fixture tests already verify writes and revision conflicts; no live skill has
been changed by this implementation. Root or permission failures remain visible.

## Save and filesystem contract

- `GET /api/omni/skills` returns IDs, names, relative locations and editability.
- `GET /api/omni/skills/:id` adds UTF-8 text and its SHA-256 revision when readable.
- `PUT /api/omni/skills/:id` accepts only `{text, revision}`. A changed revision answers
  `409 skill_revision_conflict`; the app keeps the draft and asks for an explicit reload.
- IDs are opaque hashes of paths from the bounded catalog. Clients never select host
  paths. Only existing `SKILL.md` files can be saved. Reads use a fixed 64 KiB + 1 buffer;
  larger files, invalid UTF-8, over 500 directories/documents or depth over four fail
  explicitly rather than reporting an incomplete successful catalog.
- Saves serialize per ID, check current bytes and file/ancestor identity, write a new
  temporary file beside the target, sync it and atomically replace only `SKILL.md`.
  Existing permissions and adjacent files are retained. Read/open uses `O_NOFOLLOW` and
  inode checks; ancestor identities are rechecked before reading and replacing.

The local filesystem administrator is trusted. This is not an OS sandbox against a
privileged process racing path components between the final check and rename. Concurrent
Omni saves are serialized and detected; ordinary external edits are revision-checked.
An external editor that races precisely after the final revision check cannot be given
an atomic cross-application compare-and-swap guarantee without a shared locking protocol.
No claim of such a guarantee is made. Skill text is untrusted source material and is not
executed by the editor or treated as instructions to the gateway.
