// Text normalization for cache keys, rules and wave detection.
//
//   normalize("FR33 R0BUX!!!! 🔥🔥🔥🔥")  → "free robux!! 🔥🔥"
//
// Pipeline (single pass per token, no per-call regex):
//   NFKC (only when the text is not plain ASCII) → lowercase →
//   drop zero-width / bidi / tag / variation-selector chars and stray combining
//   marks (zalgo) → treat exotic blanks (braille blank, hangul filler…) as
//   spaces → per token: fold Cyrillic/Greek lookalikes when mixed with Latin,
//   fold leetspeak when the token is mostly letters → collapse runs of the same
//   code point to 2 → collapse > 3 consecutive identical tokens → single spaces,
//   trimmed → @mentions masked to "@".
//
// Non-Latin text is kept intact: an all-Cyrillic / Greek / CJK token is never
// folded (Bulgarian "сос" stays "сос"), only mixed-script tokens are.
//
// The model never sees this string; it sees `cleanForModel(original)`.

const MAX_IN = 600;
const MAX_OUT = 320;
const MAX_TOKEN_REPEAT = 3;

const SPACE = 1;
const DROP = 2;

/** Character kind: 0 normal, 1 separator, 2 dropped. `cp` is a code point. */
function kind(cp: number): number {
  if (cp < 0x80) return cp <= 0x20 ? SPACE : cp === 0x7f ? DROP : 0;
  if (cp < 0xa0) return cp === 0x85 ? SPACE : DROP; // C1 controls
  if (cp === 0xa0) return SPACE;
  if (cp === 0xad) return DROP;
  if (cp < 0x300) return 0;
  // Combining marks used for zalgo / diacritic abuse. After NFKC, legitimate
  // Latin/Greek/Cyrillic diacritics are precomposed, so leftovers are noise.
  if (cp <= 0x36f) return DROP;
  if (cp === 0x34f) return DROP;
  if (cp >= 0x483 && cp <= 0x489) return DROP;
  if (cp === 0x61c) return DROP;
  if (cp === 0x115f || cp === 0x1160) return SPACE; // hangul fillers (invisible)
  if (cp === 0x1680) return SPACE;
  if (cp === 0x17b4 || cp === 0x17b5) return DROP;
  if (cp >= 0x180b && cp <= 0x180f) return DROP;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return DROP;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return DROP;
  if (cp >= 0x2000 && cp <= 0x200a) return SPACE;
  if (cp >= 0x200b && cp <= 0x200f) return DROP;
  if (cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f) return SPACE;
  if (cp >= 0x202a && cp <= 0x202e) return DROP;
  if (cp >= 0x2060 && cp <= 0x206f) return DROP;
  if (cp >= 0x20d0 && cp <= 0x20ff) return DROP;
  if (cp === 0x2800) return SPACE; // braille blank (ascii-art padding)
  if (cp === 0x3000 || cp === 0x3164) return SPACE;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return DROP;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return DROP;
  if (cp === 0xfeff) return DROP;
  if (cp === 0xffa0) return SPACE;
  if (cp >= 0x1d173 && cp <= 0x1d17a) return DROP;
  if (cp >= 0xe0000 && cp <= 0xe01ef) return DROP; // tags (incl. U+E0000 dup-bypass) + VS supplement
  return 0;
}

function mapOf(pairs: string): Map<number, number> {
  // "аa сc ..." → Map(cp → cp)
  const m = new Map<number, number>();
  for (const pair of pairs.split(' ')) {
    if (!pair) continue;
    const cps = Array.from(pair);
    m.set(cps[0]!.codePointAt(0)!, cps[1]!.codePointAt(0)!);
  }
  return m;
}

/** Latin-script lookalikes NFKC leaves alone: folded everywhere. */
const ALWAYS = mapOf(
  'ᴀa ʙb ᴄc ᴅd ᴇe ғf ɢg ʜh ɪi ᴊj ᴋk ʟl ᴍm ɴn ᴏo ᴘp ǫq ʀr ꜱs ᴛt ᴜu ᴠv ᴡw ʏy ᴢz ' +
    'ꜰf ꜱs ɡg ıi ɑa ɩi ꞵb ʋv ⱳw ꝺd ',
);
// Negative circled / squared letters 🅐-🅩 / 🅰-🆉 (no NFKC decomposition).
for (let i = 0; i < 26; i++) {
  ALWAYS.set(0x1f150 + i, 97 + i);
  ALWAYS.set(0x1f170 + i, 97 + i);
}

/** Cyrillic / Greek lowercase lookalikes, folded only inside mixed-script tokens. */
const HOMO = mapOf(
  // Cyrillic (lowercase; uppercase lookalikes В Н М Т К land here after toLowerCase)
  'аa вb сc ԁd еe ѐe ёe һh нh іi їi јj кk ӏl мm оo рp ԛq ѕs тt уy ўy хx ԝw ьb үy ' +
    // Greek
    'αa άa βb γy εe έe ηn ήn ιi ίi ϊi κk νv οo όo ρp τt υu ύu ϋu χx ωw ώw ϲc ϳj μu ',
);

/** Leetspeak, applied to ASCII chars inside tokens that are mostly letters. */
const LEET = new Int32Array(128).fill(-1);
LEET[0x30] = 0x6f; // 0 → o
LEET[0x31] = 0x69; // 1 → i
LEET[0x33] = 0x65; // 3 → e
LEET[0x34] = 0x61; // 4 → a
LEET[0x35] = 0x73; // 5 → s
LEET[0x37] = 0x74; // 7 → t
LEET[0x40] = 0x61; // @ → a (not at token start: that is a mention)
LEET[0x24] = 0x73; // $ → s (not at token start: "$5")

function isLatinLetter(cp: number): boolean {
  return (
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0xdf && cp <= 0x24f && cp !== 0xf7) ||
    (cp >= 0x1e00 && cp <= 0x1eff)
  );
}

// Reused output buffer (UTF-16 code units). Content scripts are single threaded.
const buf = new Uint16Array(MAX_OUT + 8);

function asciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false;
  return true;
}

export function normalize(input: string): string {
  let s = input.length > MAX_IN ? input.slice(0, MAX_IN) : input;
  if (!asciiOnly(s)) s = s.normalize('NFKC');
  s = s.toLowerCase();
  const len = s.length;
  let n = 0;
  let i = 0;
  let prevStart = -1;
  let prevEnd = -1;
  let tokRepeat = 0;

  while (i < len && n < MAX_OUT) {
    // ── skip separators / dropped chars before a token
    let cp = s.codePointAt(i)!;
    let k = kind(cp);
    if (k !== 0) {
      i += cp > 0xffff ? 2 : 1;
      continue;
    }

    // ── pass 1: find token end + script stats
    let j = i;
    let latin = 0;
    let conf = 0;
    let digits = 0;
    // "60fps", "1st", "1080p", "100k": leading number + unit suffix → not leet
    const leadDigit = s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39;
    let digitAfterOther = false;
    let other = false;
    while (j < len) {
      cp = s.codePointAt(j)!;
      k = kind(cp);
      if (k === SPACE) break;
      j += cp > 0xffff ? 2 : 1;
      if (k === DROP) continue;
      if (cp < 0x80) {
        if (cp >= 0x61 && cp <= 0x7a) {
          latin++;
          other = true;
        } else if ((cp >= 0x30 && cp <= 0x39) || cp === 0x40 || cp === 0x24) {
          digits++;
          if (other) digitAfterOther = true;
        } else other = true;
      } else {
        other = true;
        const a = ALWAYS.get(cp);
        if (a !== undefined) latin++;
        else if (HOMO.has(cp)) conf++;
        else if (isLatinLetter(cp)) latin++;
      }
    }
    const foldHomo = latin > 0 && conf > 0;
    const letters = latin + (foldHomo ? conf : 0);
    const foldLeet = letters > 0 && letters >= digits && !(leadDigit && !digitAfterOther);

    // ── token start: separator space
    const spaceAt = n;
    if (n > 0) buf[n++] = 0x20;
    const tokStart = n;

    // ── @mention → "@"
    if (s.charCodeAt(i) === 0x40 && j - i > 1) {
      buf[n++] = 0x40;
      i = j;
    } else {
      // ── pass 2: emit with folding + run collapsing
      let last = -1;
      let run = 0;
      let first = true;
      while (i < j && n < MAX_OUT) {
        cp = s.codePointAt(i)!;
        i += cp > 0xffff ? 2 : 1;
        if (kind(cp) === DROP) continue;
        let c = cp;
        if (c < 0x80) {
          if (foldLeet) {
            const l = LEET[c]!;
            if (l >= 0 && !(first && (c === 0x40 || c === 0x24))) c = l;
          }
        } else {
          const a = ALWAYS.get(c);
          if (a !== undefined) c = a;
          else if (foldHomo) {
            const h = HOMO.get(c);
            if (h !== undefined) c = h;
          }
        }
        first = false;
        if (c === last) {
          if (++run > 2) continue;
        } else {
          last = c;
          run = 1;
        }
        if (c > 0xffff) {
          const v = c - 0x10000;
          buf[n++] = 0xd800 + (v >> 10);
          buf[n++] = 0xdc00 + (v & 0x3ff);
        } else {
          buf[n++] = c;
        }
      }
      i = j;
    }

    // ── empty token (all dropped) → undo separator
    if (n === tokStart) {
      n = spaceAt;
      continue;
    }
    // ── consecutive identical tokens: keep at most MAX_TOKEN_REPEAT
    const tl = n - tokStart;
    let same = prevStart >= 0 && prevEnd - prevStart === tl;
    if (same) {
      for (let q = 0; q < tl; q++) {
        if (buf[prevStart + q] !== buf[tokStart + q]) {
          same = false;
          break;
        }
      }
    }
    if (same) {
      if (++tokRepeat > MAX_TOKEN_REPEAT) n = spaceAt;
    } else {
      prevStart = tokStart;
      prevEnd = n;
      tokRepeat = 1;
    }
  }
  if (n === 0) return '';
  return String.fromCharCode.apply(null, buf.subarray(0, n) as unknown as number[]);
}

// ───────────────────────────── model text ─────────────────────────────

const RE_INVISIBLE =
  /[­͏؜឴឵᠋-᠏​-‏‪-‮⁠-⁯︀-️﻿]|\uDB40[\uDC00-\uDDEF]/g;
const RE_BLANKS = /[\sᅟᅠ⠀ㅤﾠ]+/g;
const RE_ZALGO =
  /([̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯])[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]+/g;
const MODEL_MAX = 400;

/**
 * Light cleaning for the text the model sees: keep case, script, emoji and
 * character runs (the model learned walls of repeated characters as spam),
 * drop invisible chars, squash zalgo stacks, cap length at 400 chars,
 * single-space. ml/train/textclean.py is the same function for training and
 * evaluation; keep the two in sync.
 */
export function cleanForModel(text: string): string {
  if (isClean(text)) return text;
  let s = text.length > MODEL_MAX * 2 ? text.slice(0, MODEL_MAX * 2) : text;
  s = s.replace(RE_INVISIBLE, '').replace(RE_ZALGO, '$1').replace(RE_BLANKS, ' ');
  s = s.trim();
  return s.length > MODEL_MAX ? s.slice(0, MODEL_MAX) : s;
}

/** Fast path: printable ASCII, single spaces, trimmed, short → nothing to clean. */
function isClean(s: string): boolean {
  const n = s.length;
  if (n === 0 || n > MODEL_MAX) return false;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || (c === 0x20 && prev === 0x20)) return false;
    prev = c;
  }
  return s.charCodeAt(0) !== 0x20 && s.charCodeAt(n - 1) !== 0x20;
}

/** Number of space-separated tokens in a normalized string. */
export function tokenCount(norm: string): number {
  if (!norm) return 0;
  let c = 1;
  for (let i = 0; i < norm.length; i++) if (norm.charCodeAt(i) === 0x20) c++;
  return c;
}
