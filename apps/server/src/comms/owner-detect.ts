// Which bridge ghosts are the OWNER's own accounts (no imports: pure, also runnable on its own).
//
// Without double puppeting a mautrix bridge relays what the owner sends from his phone as his
// own ghost (`@telegram_<his id>`, `@whatsapp_<his number>`), and adds that ghost to every
// portal of the network. Production (2026-11-22): the owner's ghost sat in 86–100 % of each
// network's portals, the next most frequent ghost in at most 24 %.
//
// The gates (review rounds 1–2): a network must have enough portals to judge at all; the
// candidate must be in nearly all of them and of the DM-like ones; it must dominate every other
// ghost; and it must (almost) never be ALONE in a DM portal — the owner's ghost sits beside the
// contact, while a contact's own DM holds only that contact. "Almost": one room, or 5 % of its
// DM-like rooms. A room the bridge gives NO room type is not a DM portal when it holds a single
// ghost (production: the owner's Telegram ghost alone in 9 rooms, 6 of them untyped channels
// whose other members are not bridged) — it is left out of the DM-like set altogether.
//
// A WhatsApp owner may appear as two ids, phone and LID forms: production had the LID form in
// 207 of 240 portals and the phone form in all 33 others (plus 7 shared). The other form is the
// candidate that fills MOST of the DM-like rooms the first is missing from (a contact is in one
// DM at most), is mostly absent where the first id is (≤ half its rooms shared — a spouse sits
// in the owner's family groups, the owner's own second id does not), and the pair passes the gates.
//
// Display names are a VETO only, never evidence: when the owner's names are known and a
// candidate's display name is known and shares no word with any of them, it is not the owner
// (an assistant in every client group, a relay bot in every portal — shapes no member count tells
// apart from the owner). Words are ≥ 3 letters; a shared 3-letter prefix counts ("Ben", "Benji" ↔ "Benjamin");
// a name with no letter word (a phone number) is unknown, never a veto. A name in another script
// or an unrelated nickname needs an owner alias (PUT /api/admin/people/owner {aliases}) or
// COMMS_OWNER_GHOSTS. Production: every detected ghost shares a word with the owner's name.

/** `@<network>_[lid-]<remote id>:host` — the mautrix ghost shape (identity.ts PUPPET_RE). */
const GHOST = /^@([a-z]+)_(lid-)?[a-z0-9-]+:/;
const BRIDGE_BOT = /^@[a-z]+bot:/;
const NETWORKS = new Set(["telegram", "whatsapp", "signal", "discord", "instagram", "messenger", "facebook", "twitter", "meta", "gmessages", "linkedin", "slack"]);
/** mautrix-slack ghosts are `slack_<team>-<user>`: one login (and one owner ghost) per workspace. */
const SLACK_TEAM = /^@slack_(t[a-z0-9]+)-/;

/** A network needs at least this many portals before anything is guessed. */
export const OWNER_GHOST_MIN_ROOMS = 10;
/** ...and at least this many DM-like portals (≤ 2 ghosts of the network). */
export const OWNER_GHOST_MIN_DMS = 3;
/** The candidate's share of the network's portals AND of its DM-like portals. */
export const OWNER_GHOST_MIN_SHARE = 0.8;
/** It must be in at least this many times as many portals as any other ghost. */
export const OWNER_GHOST_DOMINANCE = 2;
/** DM-like portals in which the candidate may be the ONLY ghost of the network: this many, or
 *  this share of its DM-like portals, whichever is larger. */
export const OWNER_GHOST_MAX_ALONE = 1;
export const OWNER_GHOST_MAX_ALONE_SHARE = 0.05;
/** Hysteresis: an id stored by an earlier rebuild is dropped only on a CLEAR failure. */
export const OWNER_GHOST_DROP_ALONE_SHARE = 0.1;
export const OWNER_GHOST_DROP_SHARE = 0.7;

/** One room: its member ids and, when known, the bridge's room type (undefined = not read). */
export type RoomMembers = readonly string[] | { members: readonly string[]; type?: "dm" | "group" | null };

export interface GhostStats {
  network: string;
  /** Portals of the network the id (or the pair) is in, and the network's portal count. */
  portals: number;
  networkPortals: number;
  share: number;
  dmPortals: number;
  dmShare: number;
  /** DM-like portals in which it is the only ghost of the network. */
  alone: number;
  aloneShare: number;
}

export interface OwnerDetection {
  /** The owner's ghosts, lowercased (one per network; two for a phone + LID pair). */
  owners: string[];
  /** Networks with enough portals to judge (OWNER_GHOST_MIN_ROOMS): a verdict there — owner or
   *  not — is evidence; a network below it says nothing about an id detected earlier. */
  judged: string[];
  /** Stats for every owner found and every `opts.stats` id seen (a pair: its combined stats). */
  stats: Record<string, GhostStats>;
  /** Candidates that passed the member-count gates but were vetoed by their display name. */
  vetoed: string[];
  /** Stats for a set of ids taken together (e.g. a stored pair). */
  combined(ids: readonly string[]): GhostStats | null;
}

export interface DetectOptions {
  /** The owner's own names (person note, Matrix display name): a veto source, never evidence. */
  ownerNames?: readonly string[];
  /** Ghost id (lowercased) → its display name, when known. */
  displayNames?: ReadonlyMap<string, string>;
  /** Ids to report stats for even when they are not detected (stored ids). */
  stats?: readonly string[];
}

interface Count { all: Set<number>; dm: Set<number>; alone: number }
interface Net { all: number; dm: Set<number>; ghosts: Map<string, Count> }

const aloneOk = (c: Count) => c.alone <= Math.max(OWNER_GHOST_MAX_ALONE, OWNER_GHOST_MAX_ALONE_SHARE * c.dm.size);
const isLid = (id: string) => GHOST.exec(id)?.[2] === "lid-";
/** The network an id is judged in. Slack is judged per WORKSPACE ("slack:t0123abcd"): the owner
 *  has a separate ghost in each, so no one ghost could fill 80 % of every Slack portal. */
export const ghostNetworkOf = (id: string): string | null => {
  const v = id.toLowerCase();
  const n = GHOST.exec(v)?.[1];
  if (!n || !NETWORKS.has(n)) return null;
  const team = n === "slack" ? SLACK_TEAM.exec(v)?.[1] : undefined;
  return team ? `slack:${team}` : n;
};

/** A name's words of ≥ 3 letters (digits are never a word: a phone-number name is unknown). */
const words = (s: string): string[] =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
/** Same word, or the two share a ≥ 3-letter prefix ("ben" / "benji" ↔ "benjamin"). A veto
 *  source only, so a loose match errs toward NOT vetoing. */
const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3));

/** The owner's ghosts among the member lists. `exclude` = the agent's own ids (never the owner). */
export function detectOwnerPuppets(rooms: Iterable<RoomMembers>, exclude: Iterable<string> = [], opts: DetectOptions = {}): string[] {
  return detectOwners(rooms, exclude, opts).owners;
}

export function detectOwners(rooms: Iterable<RoomMembers>, exclude: Iterable<string> = [], opts: DetectOptions = {}): OwnerDetection {
  const skip = new Set([...exclude].map((s) => s.toLowerCase()));
  const nets = new Map<string, Net>();
  let room = 0;
  for (const r of rooms) {
    room++;
    const list = Array.isArray(r) ? (r as readonly string[]) : (r as { members: readonly string[] }).members;
    const typed = !Array.isArray(r);
    const type = typed ? (r as { type?: "dm" | "group" | null }).type : undefined;
    const byNet = new Map<string, Set<string>>();
    for (const raw of list) {
      const id = raw.toLowerCase();
      if (skip.has(id) || BRIDGE_BOT.test(id)) continue;
      const net = ghostNetworkOf(id);
      if (!net) continue;
      let s = byNet.get(net);
      if (!s) byNet.set(net, (s = new Set()));
      s.add(id);
    }
    for (const [net, ghosts] of byNet) {
      let n = nets.get(net);
      if (!n) nets.set(net, (n = { all: 0, dm: new Set(), ghosts: new Map() }));
      // DM-like: ≤ 2 ghosts, not a bridge "group" — and an untyped single-ghost room is no portal.
      const dm = ghosts.size <= 2 && type !== "group" && !(typed && (type === null || type === undefined) && ghosts.size === 1);
      n.all++;
      if (dm) n.dm.add(room);
      for (const g of ghosts) {
        let c = n.ghosts.get(g);
        if (!c) n.ghosts.set(g, (c = { all: new Set(), dm: new Set(), alone: 0 }));
        c.all.add(room);
        if (dm) c.dm.add(room);
        if (dm && ghosts.size === 1) c.alone++;
      }
    }
  }

  const statsOf = (net: Net, network: string, c: Count): GhostStats => ({
    network, portals: c.all.size, networkPortals: net.all, share: net.all ? c.all.size / net.all : 0,
    dmPortals: c.dm.size, dmShare: net.dm.size ? c.dm.size / net.dm.size : 0,
    alone: c.alone, aloneShare: c.dm.size ? c.alone / c.dm.size : 0,
  });
  const merge = (cs: Count[]): Count => ({
    all: new Set(cs.flatMap((c) => [...c.all])), dm: new Set(cs.flatMap((c) => [...c.dm])), alone: cs.reduce((a, c) => a + c.alone, 0),
  });
  const ownerWords = new Set((opts.ownerNames ?? []).flatMap(words));
  const vetoed = (id: string): boolean => {
    if (!ownerWords.size) return false;
    const dn = opts.displayNames?.get(id);
    if (!dn || !dn.trim()) return false;
    const w = words(dn);
    // No letter word (a phone number, digits, emoji only) = an unknown name: no veto.
    return w.length > 0 && !w.some((x) => [...ownerWords].some((o) => sameWord(x, o)));
  };

  const owners: string[] = [];
  const judged: string[] = [];
  const vetoedIds: string[] = [];
  const stats: Record<string, GhostStats> = {};
  for (const [net, n] of nets) {
    if (n.all < OWNER_GHOST_MIN_ROOMS || n.dm.size < OWNER_GHOST_MIN_DMS) continue;
    judged.push(net);
    const ranked = [...n.ghosts].sort((a, b) => b[1].all.size - a[1].all.size);
    const top = ranked[0];
    if (!top) continue;
    const passes = (ids: string[], c: Count): boolean => {
      if (!aloneOk(c) || c.dm.size < OWNER_GHOST_MIN_DMS) return false;
      if (c.all.size / n.all < OWNER_GHOST_MIN_SHARE || c.dm.size / n.dm.size < OWNER_GHOST_MIN_SHARE) return false;
      const other = ranked.find(([g]) => !ids.includes(g));
      return !other || c.all.size >= OWNER_GHOST_DOMINANCE * other[1].all.size;
    };
    const partner = partnerOf(top, ranked, [...n.dm].filter((r) => !top[1].dm.has(r)));
    const pairOk = (p: [string, Count] | null): p is [string, Count] => {
      if (!p || !aloneOk(p[1]) || !passes([top[0], p[0]], merge([top[1], p[1]]))) return false;
      if (vetoed(p[0])) { vetoedIds.push(p[0]); return false; }
      return true;
    };
    if (vetoed(top[0])) {
      if (passes([top[0]], top[1]) || (partner && passes([top[0], partner[0]], merge([top[1], partner[1]])))) vetoedIds.push(top[0]);
      continue;
    }
    if (passes([top[0]], top[1])) {
      owners.push(top[0]);
      stats[top[0]] = statsOf(n, net, top[1]);
      if (pairOk(partner)) {
        owners.push(partner[0]);
        stats[partner[0]] = statsOf(n, net, merge([top[1], partner[1]]));
      }
      continue;
    }
    // The owner split across two forms: judge the pair as one candidate.
    if (pairOk(partner)) {
      owners.push(top[0], partner[0]);
      const both = statsOf(n, net, merge([top[1], partner[1]]));
      stats[top[0]] = both;
      stats[partner[0]] = both;
    }
  }
  const combined = (ids: readonly string[]): GhostStats | null => {
    const lower = ids.map((i) => i.toLowerCase());
    const net = lower.map(ghostNetworkOf).find((x): x is string => !!x);
    const n = net ? nets.get(net) : undefined;
    if (!n || !net) return null;
    const cs = lower.map((i) => n.ghosts.get(i)).filter((c): c is Count => !!c);
    return statsOf(n, net, cs.length ? merge(cs) : { all: new Set(), dm: new Set(), alone: 0 });
  };
  for (const id of opts.stats ?? []) {
    const k = id.toLowerCase();
    if (!stats[k]) { const s = combined([k]); if (s) stats[k] = s; }
  }
  return { owners, judged, stats, vetoed: vetoedIds, combined };
}

/**
 * The owner's other form: of the ghosts of the OTHER form (LID vs not), the one that fills the
 * MOST of the DM-like rooms `top` is missing from — at least OWNER_GHOST_MIN_DMS and half of them —
 * and shares at most half of its own rooms with `top`.
 */
function partnerOf(top: [string, Count], ranked: Array<[string, Count]>, missingDms: number[]): [string, Count] | null {
  if (missingDms.length < OWNER_GHOST_MIN_DMS) return null;
  let best: [string, Count] | null = null;
  let bestFills = 0;
  for (const cand of ranked) {
    if (cand[0] === top[0] || isLid(cand[0]) === isLid(top[0])) continue;
    const fills = missingDms.filter((r) => cand[1].dm.has(r)).length;
    const shared = [...cand[1].all].filter((r) => top[1].all.has(r)).length;
    if (fills < OWNER_GHOST_MIN_DMS || fills < 0.5 * missingDms.length || shared > 0.5 * cand[1].all.size) continue;
    if (fills > bestFills) { best = cand; bestFills = fills; }
  }
  return best;
}

/** A stored id (or stored pair) fails CLEARLY: hysteresis for ids an earlier rebuild found. */
export function clearlyFails(s: GhostStats | null): boolean {
  if (!s || s.portals === 0) return true;
  return s.aloneShare > OWNER_GHOST_DROP_ALONE_SHARE || s.share < OWNER_GHOST_DROP_SHARE || s.dmShare < OWNER_GHOST_DROP_SHARE;
}

export interface Reconciled {
  /** The detected ids in effect. */
  ids: string[];
  added: string[];
  removed: string[];
  /** Networks on which an earlier id was dropped: nothing new is auto-detected there until a reset. */
  blocked: string[];
  /** Networks where a new id was found but not adopted (blocked, or an earlier id still stands). */
  suppressed: string[];
}

/**
 * The detected set after this rebuild, from the earlier one. Per network:
 * - an earlier id (or pair) stands unless this pass is healthy, judged the network and the id
 *   fails CLEARLY (`clearlyFails`) — no evidence, no change;
 * - when an earlier id is dropped the network is BLOCKED: its ghost vanishing may mean double
 *   puppeting was turned on, and the next most frequent ghost is then a contact. Nothing new is
 *   adopted there until an override or an explicit reset;
 * - a network with no earlier id (and not blocked) takes what detection found;
 * - a network whose earlier id stands takes new ids only when detection found the earlier ones too
 *   (the second form of the same account joining it).
 */
export function reconcileOwners(d: OwnerDetection, previous: readonly string[], blocked: readonly string[], healthy: boolean): Reconciled {
  const prevBy = new Map<string, string[]>();
  for (const id of previous.map((p) => p.toLowerCase())) {
    const net = ghostNetworkOf(id) ?? "matrix";
    prevBy.set(net, [...(prevBy.get(net) ?? []), id]);
  }
  const foundBy = new Map<string, string[]>();
  for (const id of d.owners) {
    const net = ghostNetworkOf(id) ?? "matrix";
    foundBy.set(net, [...(foundBy.get(net) ?? []), id]);
  }
  const block = new Set(blocked);
  const ids: string[] = [];
  const suppressed: string[] = [];
  for (const net of new Set([...prevBy.keys(), ...foundBy.keys(), ...block])) {
    const prev = prevBy.get(net) ?? [];
    const found = foundBy.get(net) ?? [];
    if (prev.length) {
      const drop = healthy && d.judged.includes(net) && !prev.every((p) => found.includes(p)) && clearlyFails(d.combined(prev));
      if (drop) {
        block.add(net);
        if (found.some((f) => !prev.includes(f))) suppressed.push(net);
        continue;
      }
      ids.push(...prev);
      const extra = found.filter((f) => !prev.includes(f));
      if (extra.length) {
        if (prev.every((p) => found.includes(p))) ids.push(...extra);
        else suppressed.push(net);
      }
      continue;
    }
    if (block.has(net)) {
      if (found.length) suppressed.push(net);
      continue;
    }
    ids.push(...found);
  }
  const before = new Set(previous.map((p) => p.toLowerCase()));
  const now = new Set(ids);
  return {
    ids,
    added: ids.filter((i) => !before.has(i)),
    removed: [...before].filter((i) => !now.has(i)),
    blocked: [...block],
    suppressed,
  };
}
