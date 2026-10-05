/**
 * Emoji for the inline `:` menu (NP-ED-27).
 *
 * Two sets. `BASE` (~70 common emoji with their usual shortcodes) is part of the
 * editor chunk, so the menu answers at once and offline. The full set is the data
 * file `emoji-picker-react` already ships — imported on its own (no React UI) as a
 * LAZY chunk on the first `:`. That file has names and keywords but no shortcodes:
 * an emoji's shortcode is its full name with underscores (`waving_hand`), plus the
 * BASE aliases (`wave`, `+1`, `tada`…).
 */
export interface EmojiEntry {
  /** The character, without a skin tone. */
  c: string;
  /** Unified code points, lower-case hex joined by `-`. */
  u: string;
  /** Shortcodes, the preferred one first. */
  s: string[];
  /** Search words. */
  k: string[];
  /** Skin-tone variants (unified), when the emoji has them. */
  v?: string[];
}

const fromUnified = (u: string) => String.fromCodePoint(...u.split("-").map((h) => parseInt(h, 16)));
const bare = (u: string) => u.replace(/-fe0f/g, "");

// [unified, shortcodes, keywords, has skin tones]
const BASE_ROWS: Array<[string, string, string, boolean?]> = [
  ["1f604", "smile", "happy joy"],
  ["1f600", "grinning", "happy face"],
  ["1f601", "grin", "happy teeth"],
  ["1f602", "joy", "laugh tears lol"],
  ["1f923", "rofl", "laugh rolling lol"],
  ["1f605", "sweat_smile", "relief nervous"],
  ["1f60a", "blush", "happy shy smile"],
  ["1f642", "slightly_smiling_face slight_smile", "smile"],
  ["1f643", "upside_down_face upside_down", "silly sarcasm"],
  ["1f609", "wink", "flirt"],
  ["1f60d", "heart_eyes", "love crush"],
  ["1f618", "kissing_heart", "kiss love"],
  ["1f60e", "sunglasses", "cool"],
  ["1f914", "thinking thinking_face", "hmm consider"],
  ["1f607", "innocent", "angel halo"],
  ["1f610", "neutral_face", "meh"],
  ["1f644", "roll_eyes", "eyeroll"],
  ["1f62c", "grimacing", "awkward teeth"],
  ["1f622", "cry", "sad tear"],
  ["1f62d", "sob", "cry sad tears"],
  ["1f621", "rage", "angry mad"],
  ["1f631", "scream", "shock fear"],
  ["1f634", "sleeping", "tired zzz"],
  ["1f92f", "exploding_head", "mind blown"],
  ["1f973", "partying_face party", "celebrate birthday"],
  ["1f44d", "+1 thumbsup", "yes approve like ok", true],
  ["1f44e", "-1 thumbsdown", "no dislike", true],
  ["1f44f", "clap", "applause bravo", true],
  ["1f64f", "pray", "thanks please hope", true],
  ["1f4aa", "muscle", "strong flex", true],
  ["1f44b", "wave", "hello hi bye", true],
  ["1f64c", "raised_hands", "hooray celebrate", true],
  ["1f44c", "ok_hand", "okay perfect", true],
  ["270c-fe0f", "v", "peace victory", true],
  ["1f91e", "crossed_fingers", "luck hope", true],
  ["1f449", "point_right", "this", true],
  ["1f91d", "handshake", "deal agree"],
  ["1f440", "eyes", "look see watching"],
  ["1f9e0", "brain", "think smart idea"],
  ["2764-fe0f", "heart", "love red"],
  ["1f494", "broken_heart", "sad love"],
  ["1f4af", "100", "hundred perfect score"],
  ["1f525", "fire", "hot lit flame"],
  ["2728", "sparkles", "shiny new magic"],
  ["2b50", "star", "favorite"],
  ["1f389", "tada", "party celebrate congratulations"],
  ["1f680", "rocket", "launch ship fast"],
  ["2705", "white_check_mark check", "done yes complete"],
  ["274c", "x", "no wrong cross"],
  ["26a0-fe0f", "warning", "caution alert"],
  ["2753", "question", "ask help"],
  ["2757", "exclamation", "important bang"],
  ["1f4a1", "bulb", "idea light"],
  ["1f4cc", "pushpin", "pin location"],
  ["1f4ce", "paperclip", "attach file"],
  ["1f4dd", "memo pencil", "note write"],
  ["1f4c5", "date calendar", "schedule day"],
  ["23f0", "alarm_clock", "time deadline"],
  ["1f512", "lock", "secure private"],
  ["1f511", "key", "password access"],
  ["1f517", "link", "url chain"],
  ["1f4c8", "chart_with_upwards_trend chart", "graph growth up"],
  ["1f41b", "bug", "insect defect"],
  ["1f331", "seedling", "plant grow sprout"],
  ["1f30d", "earth_africa earth", "world globe planet"],
  ["2600-fe0f", "sunny sun", "weather bright"],
  ["2615", "coffee", "drink cafe tea"],
  ["1f355", "pizza", "food slice"],
  ["1f3af", "dart", "target goal bullseye"],
  ["1f3c6", "trophy", "win award prize"],
  ["1f4ac", "speech_balloon", "comment chat talk"],
  ["1f4b0", "moneybag", "money cash"],
  ["26a1", "zap", "lightning fast power"],
];
const TONES = ["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"];

export const BASE_EMOJI: EmojiEntry[] = BASE_ROWS.map(([u, s, k, tone]) => ({
  c: fromUnified(u),
  u,
  s: s.split(" "),
  k: k.split(" "),
  v: tone ? TONES.map((t) => `${bare(u)}-${t}`) : undefined,
}));

let full: EmojiEntry[] | null = null;
let loading: Promise<EmojiEntry[]> | null = null;
const listeners = new Set<() => void>();

/** The set the menu searches now: the full one once it has arrived. */
export function emojiSet(): EmojiEntry[] {
  return full ?? BASE_EMOJI;
}
export function emojiSetIsFull(): boolean {
  return full !== null;
}
export function onEmojiSetChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

interface RawEmoji { n: string[]; u: string; v?: string[] }
/** Build the full set from the picker's data (exported for the test of the mapping). */
export function buildEmojiSet(groups: Record<string, RawEmoji[]>): EmojiEntry[] {
  const aliases = new Map(BASE_EMOJI.map((e) => [bare(e.u), e]));
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  // The common ones first, in their own order: ties in a search go to them.
  const add = (raw: RawEmoji) => {
    const key = bare(raw.u);
    if (seen.has(key)) return;
    seen.add(key);
    const names = raw.n.map((n) => n.toLowerCase());
    const name = names[names.length - 1] ?? "";
    const code = name.replace(/[^a-z0-9+]+/g, "_").replace(/^_+|_+$/g, "");
    const base = aliases.get(key);
    const s = [...(base?.s ?? []), ...(code && !base?.s.includes(code) ? [code] : [])];
    out.push({ c: fromUnified(raw.u), u: raw.u, s, k: [...new Set([...(base?.k ?? []), ...names])], v: raw.v ?? base?.v });
  };
  const all: RawEmoji[] = [];
  for (const group of Object.values(groups)) for (const raw of group) if (raw && typeof raw.u === "string" && Array.isArray(raw.n)) all.push(raw);
  const byKey = new Map(all.map((raw) => [bare(raw.u), raw]));
  for (const e of BASE_EMOJI) { const raw = byKey.get(bare(e.u)); if (raw) add(raw); else { seen.add(bare(e.u)); out.push(e); } }
  for (const raw of all) add(raw);
  return out;
}

/** Fetch the full set (a lazy chunk). Safe to call often; a failure (offline) leaves the base set. */
export function loadEmojiSet(): Promise<EmojiEntry[]> {
  if (full) return Promise.resolve(full);
  if (!loading) {
    loading = import("emoji-picker-react/dist/data/emojis-en")
      .then((mod) => {
        full = buildEmojiSet((mod.default as unknown as { emojis: Record<string, RawEmoji[]> }).emojis);
        for (const fn of listeners) fn();
        return full;
      })
      .catch(() => { loading = null; return BASE_EMOJI; });
  }
  return loading;
}

// ── Device-local memory: recent emoji and the last skin tone ────────────────
const RECENT_KEY = "prism:emoji:recent";
const TONE_KEY = "prism:emoji:tone";
const RECENT_MAX = 24;

export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
/** Remember an inserted emoji (its toneless unified code). */
export function rememberEmoji(unified: string): void {
  const key = stripTone(unified);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recentEmoji().filter((x) => x !== key)].slice(0, RECENT_MAX))); } catch { /* memory only */ }
}
export function emojiTone(): string | null {
  try { const t = localStorage.getItem(TONE_KEY); return t && TONES.includes(t) ? t : null; } catch { return null; }
}
export function rememberEmojiTone(tone: string | null | undefined): void {
  try { if (tone && TONES.includes(tone)) localStorage.setItem(TONE_KEY, tone); else localStorage.removeItem(TONE_KEY); } catch { /* memory only */ }
}
function stripTone(unified: string): string {
  return bare(unified.split("-").filter((part) => !TONES.includes(part)).join("-"));
}

/** The character to insert: the entry in the remembered skin tone when it has one. */
export function emojiChar(entry: EmojiEntry, tone: string | null = emojiTone()): string {
  if (!tone || !entry.v?.length) return entry.c;
  const first = bare(entry.u).split("-")[0];
  const variant = entry.v.find((v) => v === `${first}-${tone}` || v === `${bare(entry.u)}-${tone}`) ?? entry.v.find((v) => { const parts = v.split("-").filter((p) => TONES.includes(p)); return parts.length === 1 && parts[0] === tone; });
  return variant ? fromUnified(variant) : entry.c;
}

/** Entries matching `query` (a shortcode / name / keyword prefix, then anywhere), recent ones first. */
export function searchEmoji(query: string, limit = 8, set: EmojiEntry[] = emojiSet(), recent: string[] = recentEmoji()): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const ranked: Array<{ e: EmojiEntry; score: number; i: number }> = [];
  for (let i = 0; i < set.length; i++) {
    const e = set[i];
    let score = 9;
    for (const s of e.s) {
      if (s === q) score = Math.min(score, 0);
      else if (s.startsWith(q)) score = Math.min(score, 1);
      else if (score > 3 && s.includes(q)) score = 3;
    }
    if (score > 2) {
      for (const k of e.k) {
        if (k.startsWith(q) || k.includes(` ${q}`)) { score = Math.min(score, 2); break; }
        if (score > 4 && k.includes(q)) score = 4;
      }
    }
    if (score < 9) ranked.push({ e, score, i });
  }
  const recency = (e: EmojiEntry) => { const at = recent.indexOf(stripTone(e.u)); return at < 0 ? RECENT_MAX : at; };
  // An exact shortcode stays on top; then what was used lately; then the closest match.
  const rank = (r: { e: EmojiEntry; score: number }) => (r.score === 0 ? -1 : recency(r.e));
  ranked.sort((a, b) => (rank(a) - rank(b)) || (a.score - b.score) || (a.i - b.i));
  return ranked.slice(0, limit).map((r) => r.e);
}

/** The entry whose shortcode is exactly `name` (what `:name:` converts to). */
export function emojiForShortcode(name: string, set: EmojiEntry[] = emojiSet()): EmojiEntry | null {
  const q = name.toLowerCase();
  return set.find((e) => e.s.includes(q)) ?? null;
}
