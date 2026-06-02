#!/usr/bin/env python3
"""
One-time Parachute vault vocabulary migration.

Reconciles notes written against the *old* skill prompts / Rust writers with the
declared tag schema. It is additive and reversible by default: it COPIES drifted
values into the declared fields and NORMALIZES the `status` enum, but it does NOT
delete the legacy keys (PATCH merges metadata, so a key can only be removed by an
explicit replace pass — see --strip-legacy below, which is opt-in and best-effort).

Drift classes handled (see the 2026-06-02 investigation):
  TASKS       status enum violations  -> normalize to {todo,in-progress,blocked,done,cancelled}
              deadline (legacy)       -> due       (copy if due empty)
              requester (legacy)      -> assigned  (copy if assigned empty)
  TRANSCRIPTS sourceId  (legacy)      -> source_id (copy if empty)
              fathomUrl (legacy)      -> fathom_url(copy if empty)
  TEMPLATES   _templates/* tagged as data (e.g. person) -> drop the data tag

Safety:
  * Dry-run is the DEFAULT. Pass --apply to write.
  * Writes use force:true (matches Prism's own background writers; these notes are
    sync/agent-owned, so optimistic-concurrency 409s are not a concern here).
  * Every write is logged. Re-running is idempotent (skips already-correct notes).

Auth / endpoint (Parachute 0.5.x, vault-scoped):
  PARACHUTE_ROOT   default http://localhost:1940         (server root, NO /api)
  PARACHUTE_VAULT  default default
  PARACHUTE_TOKEN  hub-issued JWT, scope vault:<name>:write   (required for --apply)
    mint with:  parachute auth mint-token --scope vault:default:write --ephemeral

Usage:
  python3 scripts/migrate-vault-vocab.py                 # dry-run, all phases
  python3 scripts/migrate-vault-vocab.py --phase tasks   # dry-run, tasks only
  PARACHUTE_TOKEN=... python3 scripts/migrate-vault-vocab.py --apply
  python3 scripts/migrate-vault-vocab.py --fill-null-status   # also set status=todo where missing
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.environ.get("PARACHUTE_ROOT", "http://localhost:1940").rstrip("/")
VAULT = os.environ.get("PARACHUTE_VAULT", "default")
TOKEN = os.environ.get("PARACHUTE_TOKEN", "")
API = f"{ROOT}/vault/{VAULT}/api"

# --- Decision table: legacy/invalid status value -> declared enum value ---------
# The declared `task.status` enum is: todo, in-progress, blocked, done, cancelled.
# Two of these are judgment calls (flagged); override here if you disagree:
STATUS_MAP = {
    "pending": "todo",          # clear: not-yet-started
    "active": "in-progress",    # JUDGMENT CALL: "active" == being worked (could be "todo")
    "waiting": "blocked",       # waiting on an external party == blocked
    "resolved": "done",
    "completed": "done",
    "complete": "done",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "in_progress": "in-progress",
    "inprogress": "in-progress",
    "blocked": "blocked",
    "todo": "todo",
    "in-progress": "in-progress",
    "done": "done",
}
VALID_STATUS = {"todo", "in-progress", "blocked", "done", "cancelled"}


def req(method, path, body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if TOKEN:
        r.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return json.loads(resp.read() or "null")
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {method} {url}: {e.read().decode(errors='replace')}")


def list_by_tag(tag):
    """Paginate all notes for a tag (metadata included, content excluded)."""
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode(
            {"tag": tag, "limit": 200, "offset": offset, "include_content": "false"}
        )
        page = req("GET", f"/notes?{q}")
        notes = page if isinstance(page, list) else page.get("notes", [])
        if not notes:
            break
        out.extend(notes)
        if len(notes) < 200:
            break
        offset += 200
    return out


def patch_meta(note_id, meta_delta, apply):
    """Merge-PATCH metadata. force:true to match Prism's background writers."""
    if not apply:
        return
    req("PATCH", f"/notes/{note_id}", {"metadata": meta_delta, "force": True})


def as_meta(n):
    """Return a note's metadata as a dict. Some notes store metadata as a
    JSON-encoded string (itself a drift variant) — coerce those; give up to {}."""
    m = n.get("metadata")
    if isinstance(m, dict):
        return m
    if isinstance(m, str):
        try:
            parsed = json.loads(m)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def g(meta, key):
    v = (meta or {}).get(key)
    return v if isinstance(v, str) else ("" if v is None else v)


def migrate_tasks(apply, fill_null):
    print("\n=== TASKS ===")
    notes = list_by_tag("task")
    stats = {"status_fixed": 0, "deadline_copied": 0, "requester_copied": 0,
             "status_null": 0, "unknown_status": 0, "scanned": len(notes)}
    for n in notes:
        meta = as_meta(n)
        path = n.get("path", n.get("id"))
        delta = {}

        st = meta.get("status")
        if st in (None, ""):
            stats["status_null"] += 1
            if fill_null:
                delta["status"] = "todo"
        elif st not in VALID_STATUS:
            mapped = STATUS_MAP.get(str(st).strip().lower())
            if mapped:
                delta["status"] = mapped
                stats["status_fixed"] += 1
            else:
                stats["unknown_status"] += 1
                print(f"  ?? UNKNOWN status {st!r}  {path}  (left untouched)")

        if g(meta, "deadline") and not g(meta, "due"):
            delta["due"] = meta["deadline"]
            stats["deadline_copied"] += 1
        if g(meta, "requester") and not g(meta, "assigned"):
            delta["assigned"] = meta["requester"]
            stats["requester_copied"] += 1

        if delta:
            print(f"  {'APPLY' if apply else 'DRY'}  {path}: {delta}")
            patch_meta(n["id"], delta, apply)
    print(f"  -- {json.dumps(stats)}")
    return stats


def migrate_transcripts(apply):
    print("\n=== TRANSCRIPTS ===")
    notes = list_by_tag("transcript")
    stats = {"source_id_copied": 0, "fathom_url_copied": 0, "scanned": len(notes)}
    for n in notes:
        meta = as_meta(n)
        path = n.get("path", n.get("id"))
        delta = {}
        if g(meta, "sourceId") and not g(meta, "source_id"):
            delta["source_id"] = meta["sourceId"]
            stats["source_id_copied"] += 1
        if g(meta, "fathomUrl") and not g(meta, "fathom_url"):
            delta["fathom_url"] = meta["fathomUrl"]
            stats["fathom_url_copied"] += 1
        if delta:
            print(f"  {'APPLY' if apply else 'DRY'}  {path}: {delta}")
            patch_meta(n["id"], delta, apply)
    print(f"  -- {json.dumps(stats)}")
    return stats


def migrate_templates(apply):
    """Drop data-type tags from notes under _templates/ so they stop being counted
    as real data (e.g. _templates/person matching person queries)."""
    print("\n=== TEMPLATES ===")
    data_tags = ["person", "task", "meeting", "transcript", "email", "project", "organization"]
    seen, fixed = {}, 0
    for tag in data_tags:
        for n in list_by_tag(tag):
            path = (n.get("path") or "")
            if "_templates/" not in path or n["id"] in seen:
                continue
            seen[n["id"]] = path
            bad = [t for t in (n.get("tags") or []) if t in data_tags]
            print(f"  {'APPLY' if apply else 'DRY'}  {path}: remove tags {bad}")
            if apply and bad:
                req("PATCH", f"/notes/{n['id']}", {"tags": {"remove": bad}, "force": True})
            fixed += 1
    print(f"  -- templates_fixed: {fixed}")
    return {"templates_fixed": fixed}


def main():
    ap = argparse.ArgumentParser(description="Parachute vault vocabulary migration")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--phase", choices=["tasks", "transcripts", "templates", "all"],
                    default="all")
    ap.add_argument("--fill-null-status", action="store_true",
                    help="also set status=todo on tasks missing a status")
    args = ap.parse_args()

    if args.apply and not TOKEN:
        sys.exit("--apply requires PARACHUTE_TOKEN (vault:%s:write JWT)" % VAULT)

    print(f"Vault: {API}   mode: {'APPLY' if args.apply else 'DRY-RUN'}   phase: {args.phase}")
    if args.phase in ("tasks", "all"):
        migrate_tasks(args.apply, args.fill_null_status)
    if args.phase in ("transcripts", "all"):
        migrate_transcripts(args.apply)
    if args.phase in ("templates", "all"):
        migrate_templates(args.apply)
    print("\nDone." + ("" if args.apply else "  (dry-run — no writes. Re-run with --apply.)"))


if __name__ == "__main__":
    main()
