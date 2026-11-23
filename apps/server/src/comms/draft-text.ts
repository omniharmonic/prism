// The character policy for Omni's chat drafts (Task 2 review rounds 1–3; controller rulings of
// round 3: strict and simple, the same rule here and in the Swift twin CommsCore/DraftText.swift,
// enforced at propose AND at approve). The owner approves the text he READS: a draft may hold
// nothing he cannot see.
//
// Whitespace: only U+0020 and LF. Tab refused; CR is normalised away at propose. No trailing spaces
// on any line, at most 2 consecutive blank lines, no leading or trailing blank lines. `normalizeDraft`
// makes a proposed body conform (so the stored draft — what the sheet shows — is byte-identical to
// what is digested and sent); at approve the body must ALREADY be normalised.
//
// Refused code points: every control character but LF; every space separator but U+0020; line and
// paragraph separators; every format character (Cf: ZWNJ, bidi, word joiner, BOM, soft hyphen …);
// every Default_Ignorable_Code_Point; tag characters U+E0000–E007F (no subdivision flags — an
// accepted loss); every variation selector (U+FE00–FE0F, U+E0100–E01EF); U+2800 (braille blank);
// U+FFFC; a skin-tone modifier that does not directly follow an Emoji_Modifier_Base.
// Exceptions, exactly:
//   - ONE U+FE0F directly after a character with the Emoji property (not stacked);
//   - U+200D (ZWJ) only between two pictographs, each optionally followed by ONE U+FE0F or ONE
//     skin-tone modifier (after a modifier base), and each drawn as an emoji (Emoji_Presentation,
//     or that FE0F — stricter than the ruling: © ‍ ™ would carry a hidden bit); at most 4 ZWJs;
//   - a skin-tone modifier directly after an Emoji_Modifier_Base.
// "Pictograph" = Emoji property minus ASCII (#, *, digits), regional indicators and the skin-tone
// modifiers — exactly Emoji ∩ Extended_Pictographic, and computable from Swift's properties too.

export const DRAFT_MAX_CHARS = 4_000;
export const MAX_ZWJ_PER_SEQUENCE = 4;

const is = (re: RegExp) => (cp: number): boolean => re.test(String.fromCodePoint(cp));
const hasEmoji = is(/^\p{Emoji}$/u);
const isModifierBase = is(/^\p{Emoji_Modifier_Base}$/u);
const isEmojiPresentation = is(/^\p{Emoji_Presentation}$/u);
const isFormat = is(/^\p{Cf}$/u);
const isIgnorable = is(/^\p{Default_Ignorable_Code_Point}$/u);
const isSpaceSep = is(/^[\p{Zs}\p{Zl}\p{Zp}]$/u);

const LF = 0x0a, SPACE = 0x20, ZWJ = 0x200d, VS16 = 0xfe0f;
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
/** Emoji ∩ Extended_Pictographic, expressed with properties both platforms have. */
export const isPictograph = (cp: number): boolean => cp > 0x7f && hasEmoji(cp) && !isRegional(cp) && !isSkinTone(cp);

/** A code point a draft may not hold where no exception applies. */
export function isRefusedCodePoint(cp: number): boolean {
  if (cp === LF || cp === SPACE) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true; // controls, tab and CR included
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xe0000 && cp <= 0xe007f)) return true;
  if (cp === 0x2800 || cp === 0xfffc || isSkinTone(cp)) return true;
  return isSpaceSep(cp) || isFormat(cp) || isIgnorable(cp);
}

/** Index after one pictograph element at `i` (its optional single FE0F or skin tone). */
function element(cps: number[], i: number): number {
  const next = cps[i + 1];
  if (next === VS16) return i + 2;
  if (next !== undefined && isSkinTone(next) && isModifierBase(cps[i]!)) return i + 2;
  return i + 1;
}

/** Is the element at [i, end) drawn as an emoji (Emoji_Presentation, or its single FE0F)? A ZWJ
 *  joins only such elements — © or ™ (text-default pictographs) never take part in one. */
const presented = (cps: number[], i: number, end: number): boolean => isEmojiPresentation(cps[i]!) || (end - i === 2 && cps[i + 1] === VS16);

/** The first refused code point (index in code points), or -1. */
export function firstRefusedCodePoint(text: string): number {
  const cps = Array.from(text, (c) => c.codePointAt(0)!);
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!;
    if (isPictograph(cp)) {
      let start = i;
      let j = element(cps, i);
      let zwjs = 0;
      while (cps[j] === ZWJ && zwjs < MAX_ZWJ_PER_SEQUENCE && j + 1 < cps.length && isPictograph(cps[j + 1]!) && presented(cps, start, j)) {
        const k = element(cps, j + 1);
        if (!presented(cps, j + 1, k)) break;
        zwjs++;
        start = j + 1;
        j = k;
      }
      i = j;
      continue;
    }
    if (hasEmoji(cp)) {
      // A modifier base outside the pictographs does not exist; skin tones alone are refused below.
      if (!isSkinTone(cp)) {
        i += cps[i + 1] === VS16 ? 2 : 1;
        continue;
      }
    }
    if (isRefusedCodePoint(cp)) return i;
    i++;
  }
  return -1;
}

/** The whitespace shape a draft must have (null = fine). */
export function whitespaceProblem(text: string): string | null {
  if (text.includes("\t")) return "tabs are not allowed";
  if (text.includes("\r")) return "carriage returns are not allowed";
  if (/ (\n|$)/.test(text)) return "trailing spaces are not allowed";
  if (/\n{4,}/.test(text)) return "at most 2 blank lines in a row";
  if (text.startsWith("\n") || text.endsWith("\n")) return "no blank lines at the start or end";
  return null;
}

/**
 * Bring a proposed body to the required whitespace shape: CR/CRLF → LF, trailing spaces removed
 * from every line, runs of more than 2 blank lines collapsed to 2, leading/trailing blank lines
 * removed. Everything else (tabs, refused characters) is left for the check to refuse.
 */
export function normalizeDraft(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/ +$/, "")).join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Why a chat draft body is refused (null = fine). The body must already be normalised. */
export function draftTextProblem(body: unknown, maxBytes: number): string | null {
  if (typeof body !== "string" || !body.trim()) return "required";
  if ([...body].length > DRAFT_MAX_CHARS) return `at most ${DRAFT_MAX_CHARS} characters for a chat reply`;
  if (Buffer.byteLength(body, "utf8") > maxBytes) return "too long to send";
  const ws = whitespaceProblem(body);
  if (ws) return ws;
  if (firstRefusedCodePoint(body) >= 0) return "contains invisible or formatting characters";
  return null;
}
