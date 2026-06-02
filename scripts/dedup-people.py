#!/usr/bin/env python3
"""
Deterministic person-note de-duplication for the Parachute vault.

The `deduplication` agent-skill is good for fuzzy judgment calls but caps at the
200-note query limit and is lossy at scale. Exact clustering — same email, or
identical normalized name — is mechanical, so it belongs in a script.

Phases:
  ANALYZE (default, read-only)  cluster ALL person notes and print a merge plan.
  --apply                       execute SAFE clusters: re-point every link from
                                each duplicate onto the chosen canonical note,
                                merge metadata (channels/email/role), then delete
                                the duplicate. Fuzzy clusters are NEVER auto-merged.

Clustering:
  * SAFE  — members share a normalized email OR an identical normalized name.
            These are merged on --apply.
  * FUZZY — one normalized name strictly contains another (e.g. "aaron gabriel"
            ⊂ "aaron gabriel neyer"). Reported for human review only.

Canonical pick within a cluster (most-authoritative wins):
  1. real path (vault/people/…) over _staging/_templates stubs
  2. more metadata keys
  3. more inbound+outbound links
  4. older note (stable tiebreak)

Auth/endpoint: same as migrate-vault-vocab.py (PARACHUTE_ROOT/VAULT/TOKEN).
  Reads need a token too (the REST API is authenticated). --apply needs :write.

Usage:
  python3 scripts/dedup-people.py                 # analyze, print plan
  python3 scripts/dedup-people.py --show 40        # analyze, print up to 40 clusters
  PARACHUTE_TOKEN=… python3 scripts/dedup-people.py --apply           # merge SAFE only
  PARACHUTE_TOKEN=… python3 scripts/dedup-people.py --apply --include-fuzzy   # also fuzzy (NOT recommended)
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.environ.get("PARACHUTE_ROOT", "http://localhost:1940").rstrip("/")
VAULT = os.environ.get("PARACHUTE_VAULT", "default")
TOKEN = os.environ.get("PARACHUTE_TOKEN", "")
API = f"{ROOT}/vault/{VAULT}/api"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

# Automated/role addresses are NOT identity — clustering on them catastrophically
# fuses distinct people (every Otter.ai transcript shares no-reply@otter.ai).
# Mirrors person_linker::is_nonhuman_email on the Rust side.
_NONHUMAN_SUBSTR = ("noreply", "no-reply", "no_reply", "donotreply", "do-not-reply",
                    "notification", "mailer-daemon", "postmaster", "bounce", "automated",
                    "executiveassistant", "@e.read.ai", "otter.ai",
                    # shared sender/newsletter/org addresses — not personal identity
                    "substack.com", "mailchimp", "@e.", "@em.", "@mail.", "calendar-notification")
_NONHUMAN_ROLES = {"support", "billing", "hello", "info", "admin", "team", "help", "sales",
                   "contact", "notifications", "newsletter", "news", "updates", "alerts", "noreply"}


def is_nonhuman_email(e):
    e = e.strip().lower()
    local = e.split("@")[0]
    if any(s in e for s in _NONHUMAN_SUBSTR):
        return True
    return local in _NONHUMAN_ROLES


def req(method, path, body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if TOKEN:
        r.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read() or "null")
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {method} {url}: {e.read().decode(errors='replace')}")


def all_people(include_links=False):
    out, offset = [], 0
    while True:
        q = {"tag": "person", "limit": 200, "offset": offset, "include_content": "false"}
        if include_links:
            q["include_links"] = "true"
        page = req("GET", f"/notes?{urllib.parse.urlencode(q)}")
        notes = page if isinstance(page, list) else page.get("notes", [])
        if not notes:
            break
        out.extend(notes)
        if len(notes) < 200:
            break
        offset += 200
    return out


def norm_name(s):
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = " ".join(s.split())
    # Strip bot-ingestion suffixes so "kevin owocki via read ai" == "kevin owocki".
    s = re.sub(r"\s+(via|from)\s+(read ai|otter ai|otter|read|gmail|substack).*$", "", s)
    s = re.sub(r"\s+(gmail|outlook|yahoo|proton|protonmail)\s+com$", "", s)
    return s.strip()


def display_name(n):
    m = n.get("metadata") or {}
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    name = m.get("name")
    if not name:
        p = (n.get("path") or "").split("/")[-1]
        name = p.replace("_", " ").replace("-", " ")
    return name


def emails_of(n):
    m = n.get("metadata") or {}
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    found = set()
    ch = m.get("channels") or {}
    if isinstance(ch, dict):
        e = ch.get("email")
        for v in (e if isinstance(e, list) else [e]):
            if isinstance(v, str):
                found.update(x.lower() for x in EMAIL_RE.findall(v))
    if isinstance(m.get("email"), str):
        found.update(x.lower() for x in EMAIL_RE.findall(m["email"]))
    # path/name that is itself an email
    found.update(x.lower() for x in EMAIL_RE.findall(n.get("path") or ""))
    # Drop automated/role addresses — they are not identity.
    return {e for e in found if not is_nonhuman_email(e)}


class UF:
    def __init__(self, ids): self.p = {i: i for i in ids}
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def union(self, a, b): self.p[self.find(a)] = self.find(b)


def is_stub_path(p):
    p = (p or "").lower()
    return "_staging/" in p or "_templates/" in p


def meta_size(n):
    m = n.get("metadata") or {}
    if isinstance(m, str):
        return 1
    return len(m)


def link_count(n):
    return len(n.get("links") or [])


def is_proper_name_path(p):
    """A human-readable path like 'vault/people/Cameron Murdock' beats a slug
    ('cameron-ely-murdock') or an email-derived path ('murdock-cameron-gmail-com')."""
    leaf = (p or "").split("/")[-1]
    has_space_and_caps = " " in leaf and any(c.isupper() for c in leaf)
    looks_email_derived = bool(re.search(r"-(gmail|com|org|net|io|us|co)$", leaf))
    return has_space_and_caps and not looks_email_derived


def is_ea_managed(n):
    m = n.get("metadata") or {}
    return isinstance(m, dict) and bool(m.get("ea_managed"))


def path_cleanliness(p):
    """Lower = tidier leaf. Penalize leading/trailing dashes and dash count so
    'ryan-sage' beats 'ryan-sage-----'."""
    leaf = (p or "").split("/")[-1]
    trailing = leaf.startswith("-") or leaf.endswith("-")
    return (trailing, leaf.count("-"), len(leaf))


def canonical(members):
    # lower sort key = more authoritative
    return sorted(members, key=lambda n: (
        not is_ea_managed(n),                  # the EA's own canonical wins outright
        is_stub_path(n.get("path")),           # real path before _staging/_templates
        not is_proper_name_path(n.get("path")),  # "Cameron Murdock" before slug/email path
        -meta_size(n),                         # more metadata
        -link_count(n),                        # more links
        path_cleanliness(n.get("path")),       # tidier slug before dashy artifact
        n.get("createdAt", ""),                # older
    ))[0]


def fetch_note(nid):
    return req("GET", f"/notes/{urllib.parse.quote(nid, safe='')}")


def is_boilerplate(content):
    """Stub content carries no information worth preserving on merge."""
    c = (content or "").strip().lower()
    body = re.sub(r"^#.*$", "", c, flags=re.M).strip()
    if "auto-created by prism" in c or "person first encountered" in c:
        return True
    return len(body) < 40


def all_emails_in(meta):
    out = set()
    if not isinstance(meta, dict):
        return out
    ch = meta.get("channels") or {}
    if isinstance(ch, dict):
        e = ch.get("email")
        for v in (e if isinstance(e, list) else [e] if e else []):
            if isinstance(v, str):
                out.update(x.lower() for x in EMAIL_RE.findall(v))
    for key in ("email", "emails"):
        v = meta.get(key)
        for item in (v if isinstance(v, list) else [v] if v else []):
            if isinstance(item, str):
                out.update(x.lower() for x in EMAIL_RE.findall(item))
    return out


def merge_pair(canonical_note, secondary, when):
    """Fold `secondary` into `canonical_note` using the EA tombstone convention:
    union emails into canonical.channels.email, append any non-boilerplate content
    under a '## Merged from' section, transfer the secondary's links onto the
    canonical, then rewrite the secondary as a '# (merged)' tombstone. Never deletes."""
    can_id, sec_id = canonical_note["id"], secondary["id"]
    can_full = fetch_note(can_id)
    can_path = can_full.get("path") or can_id
    can_meta = can_full.get("metadata") if isinstance(can_full.get("metadata"), dict) else {}
    sec_full = fetch_note(sec_id)
    sec_meta = sec_full.get("metadata") if isinstance(sec_full.get("metadata"), dict) else {}

    # 1. union emails into canonical.channels.email
    emails = all_emails_in(can_meta) | all_emails_in(sec_meta)
    cur = all_emails_in(can_meta)
    if emails != cur:
        ch = dict(can_meta.get("channels") or {}) if isinstance(can_meta.get("channels"), dict) else {}
        ch["email"] = sorted(emails)
        req("PATCH", f"/notes/{can_id}", {"metadata": {"channels": ch}, "force": True})

    # 2. preserve non-boilerplate content
    sec_content = sec_full.get("content") or ""
    if not is_boilerplate(sec_content):
        sec_path = sec_full.get("path") or sec_id
        req("PATCH", f"/notes/{can_id}",
            {"append": f"\n\n## Merged from {sec_path}\n\n{sec_content}\n", "force": True})

    # 3. transfer the secondary's links onto the canonical
    for l in (secondary.get("links") or []):
        src = l.get("sourceId") or l.get("source_id")
        tgt = l.get("targetId") or l.get("target_id")
        rel = l.get("relationship")
        if not rel:
            continue
        other = tgt if src == sec_id else src
        if other in (None, can_id, sec_id):
            continue
        try:
            if src == sec_id:   # secondary -> other  ⇒  canonical -> other
                req("PATCH", f"/notes/{can_id}", {"links": {"add": [{"target": other, "relationship": rel}]}, "force": True})
            else:               # other -> secondary  ⇒  other -> canonical
                req("PATCH", f"/notes/{urllib.parse.quote(other, safe='')}",
                    {"links": {"add": [{"target": can_id, "relationship": rel}]}, "force": True})
        except SystemExit:
            pass  # link endpoint already gone / dup link — non-fatal

    # 4. rewrite the secondary as a tombstone (keeps the person tag, like the EA's own)
    tomb = (f"# (merged)\n\nThis note has been merged into [[{can_path}]] on {when[:10]}. "
            f"The canonical profile supersedes it; old references resolve here as a tombstone.")
    req("PATCH", f"/notes/{sec_id}", {
        "content": tomb,
        "metadata": {"status": "merged_into_canonical", "merged_into": can_path, "merged_at": when},
        "force": True,
    })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="tombstone-merge SAFE clusters")
    ap.add_argument("--include-fuzzy", action="store_true")
    ap.add_argument("--show", type=int, default=15)
    ap.add_argument("--junk", action="store_true", help="list non-human person notes")
    ap.add_argument("--apply-junk", action="store_true", help="declassify junk: remove person tag, add non-human")
    ap.add_argument("--emit-fuzzy", metavar="FILE", help="write fuzzy pairs grouped into components as JSON, then exit")
    args = ap.parse_args()
    if args.apply and not TOKEN:
        sys.exit("--apply requires PARACHUTE_TOKEN (vault:%s:write)" % VAULT)

    raw = all_people(include_links=args.apply)

    def is_tombstone(n):
        m = n.get("metadata") or {}
        if isinstance(m, str):
            return "merged_into_canonical" in m
        return m.get("status") == "merged_into_canonical" or bool(m.get("merged_into"))

    tombstones = [n for n in raw if is_tombstone(n)]
    people = [n for n in raw if not is_tombstone(n)]
    print(f"Scanned {len(raw)} person notes "
          f"({len(tombstones)} already tombstoned by the EA resolver, excluded; {len(people)} live).")

    ids = [n["id"] for n in people]
    by_id = {n["id"]: n for n in people}
    uf_safe = UF(ids)

    # SAFE: shared email
    email_map = {}
    for n in people:
        for e in emails_of(n):
            email_map.setdefault(e, []).append(n["id"])
    for e, group in email_map.items():
        for o in group[1:]:
            uf_safe.union(group[0], o)
    # SAFE: identical normalized name (skip empty/very short)
    name_map = {}
    for n in people:
        nm = norm_name(display_name(n))
        if len(nm) >= 4:
            name_map.setdefault(nm, []).append(n["id"])
    for nm, group in name_map.items():
        for o in group[1:]:
            uf_safe.union(group[0], o)

    safe_clusters = {}
    for i in ids:
        safe_clusters.setdefault(uf_safe.find(i), []).append(i)
    safe_clusters = {k: v for k, v in safe_clusters.items() if len(v) > 1}

    # FUZZY: name containment across distinct safe-clusters
    fuzzy = []
    names = [(norm_name(display_name(by_id[i])), i) for i in ids]
    names = [(nm, i) for nm, i in names if len(nm) >= 5]
    for a_nm, a_id in names:
        for b_nm, b_id in names:
            if a_id < b_id and a_nm != b_nm and (f" {a_nm} " in f" {b_nm} "):
                if uf_safe.find(a_id) != uf_safe.find(b_id):
                    fuzzy.append((a_id, b_id, a_nm, b_nm))

    dup_notes = sum(len(v) - 1 for v in safe_clusters.values())
    print(f"\nSAFE clusters: {len(safe_clusters)}  (would delete {dup_notes} duplicate notes, keep {len(safe_clusters)} canonicals)")
    print(f"FUZZY pairs (review only): {len(fuzzy)}")

    shown = 0
    for members in sorted(safe_clusters.values(), key=len, reverse=True):
        if shown >= args.show:
            print(f"  … and {len(safe_clusters) - shown} more SAFE clusters")
            break
        ns = [by_id[i] for i in members]
        can = canonical(ns)
        print(f"\n  CLUSTER ({len(ns)}): canonical = {can.get('path')}")
        for n in ns:
            tag = "  KEEP " if n["id"] == can["id"] else "  drop "
            print(f"  {tag}{n.get('path')}  [{', '.join(sorted(emails_of(n))) or 'no-email'}]")
        shown += 1

    if fuzzy[:args.show]:
        print("\n  FUZZY (human review):")
        for a, b, an, bn in fuzzy[:args.show]:
            print(f"    {by_id[a].get('path')}  ~?  {by_id[b].get('path')}   ({an} ⊂ {bn})")

    # ---- JUNK: non-human person notes (declassify, don't delete — preserves links) ----
    # High precision: word-boundary "bot" (so "botsford"/"abbot-as-surname" survive)
    # plus an explicit service denylist. Better to miss junk than untag a real person.
    SERVICE_SUBSTR = ("noreply", "no-reply", "no reply", "github", "read ai", "read-ai",
                      "team at read", "hacken", "xero", "vercel", "mailer-daemon", "ccasync")

    def is_junk_person(n):
        name = norm_name(display_name(n))
        leaf = (n.get("path") or "").split("/")[-1].lower().replace("_", " ").replace("-", " ")
        hay = f"{name} {leaf}"
        tokens = re.split(r"[^a-z0-9]+", hay)
        if any(t == "bot" or (t.endswith("bot") and len(t) >= 5) for t in tokens):
            return True
        return any(s in hay for s in SERVICE_SUBSTR)

    if args.junk or args.apply_junk:
        junk = [n for n in people if is_junk_person(n)]
        print(f"\nJUNK (non-human) person notes: {len(junk)}")
        for n in junk:
            print(f"  {'declassify' if args.apply_junk else 'candidate'}  {n.get('path')}")
            if args.apply_junk:
                req("PATCH", f"/notes/{n['id']}",
                    {"tags": {"add": ["non-human"], "remove": ["person"]}, "force": True})
        print("Done." if args.apply_junk else "List only. Re-run with --apply-junk to declassify.")
        return

    # ---- EMIT FUZZY: group pairs into connected components for the swarm ----
    if args.emit_fuzzy:
        uf_f = UF([i for pair in fuzzy for i in pair[:2]])
        for a, b, *_ in fuzzy:
            uf_f.union(a, b)
        comps = {}
        for a, b, an, bn in fuzzy:
            comps.setdefault(uf_f.find(a), {"members": set(), "pairs": []})
            comps[uf_f.find(a)]["members"].update([a, b])
            comps[uf_f.find(a)]["pairs"].append([a, b])
        out = []
        for c in comps.values():
            members = [{"id": i, "path": by_id[i].get("path"), "name": display_name(by_id[i])}
                       for i in c["members"]]
            out.append({"members": members, "pairs": c["pairs"]})
        out.sort(key=lambda c: len(c["members"]), reverse=True)
        with open(args.emit_fuzzy, "w") as f:
            json.dump(out, f, indent=1)
        print(f"\nWrote {len(fuzzy)} fuzzy pairs in {len(out)} components → {args.emit_fuzzy}")
        print(f"  largest components: {[len(c['members']) for c in out[:8]]}")
        return

    if not args.apply:
        print("\nAnalysis only. Re-run with --apply (and PARACHUTE_TOKEN :write) to tombstone-merge SAFE clusters.")
        return

    # ---- APPLY: tombstone-merge SAFE clusters (EA-aligned, never deletes) ----
    from datetime import datetime, timezone
    when = datetime.now(timezone.utc).isoformat()
    merged_clusters = tombstoned = 0
    for members in sorted(safe_clusters.values(), key=len, reverse=True):
        ns = [by_id[i] for i in members]
        can = canonical(ns)
        for sec in ns:
            if sec["id"] == can["id"]:
                continue
            merge_pair(can, sec, when)
            tombstoned += 1
        merged_clusters += 1
        print(f"  merged {len(ns)} → {can.get('path')}")
    print(f"\nApplied: {merged_clusters} canonicals kept, {tombstoned} duplicates tombstoned (status=merged_into_canonical).")


if __name__ == "__main__":
    main()
