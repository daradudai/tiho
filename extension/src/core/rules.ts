// Tier 0: synchronous rules (< 0.05 ms / message).
//
// Rules either *decide* a message outright (user rules, commands, floods,
// duplicates, emote-only / trivially short, obvious scam patterns) so the model
// never sees it, or attach *signals* that the policy uses to nudge model scores
// (untrusted link → scam, caps / repeats → spam, "?" → question) and as a
// fallback when no model is available.
//
// Protection (privileged author, paid message, the viewer's own message or a
// mention of the viewer) is orthogonal: the category is still computed, but
// the action is capped to show / highlight by the policy.

import { normalize, tokenCount } from './normalize';
import { LRU } from './lru';
import type { Settings, UserRule } from './settings';
import { Role, type Category, type ChatMessage } from './types';

export const Sig = {
  COMMAND: 1 << 0,
  /** Link to a domain outside the allow-list, by a non-privileged author. */
  LINK: 1 << 1,
  /** Link that is allow-listed or posted by a privileged author. */
  LINK_OK: 1 << 2,
  CHAR_FLOOD: 1 << 3,
  EMOTE_FLOOD: 1 << 4,
  CAPS: 1 << 5,
  REPEAT: 1 << 6,
  DUPLICATE: 1 << 7,
  EMOTE_ONLY: 1 << 8,
  SHORT: 1 << 9,
  MENTIONS_VIEWER: 1 << 10,
  PAID: 1 << 11,
  PRIVILEGED: 1 << 12,
  SCAM_WORDS: 1 << 13,
  QUESTION_MARK: 1 << 14,
  FIRST: 1 << 15,
  ASCII_ART: 1 << 16,
  SCAM_PATTERN: 1 << 17,
  /** Posted by the signed-in viewer. */
  OWN: 1 << 18,
} as const;

export interface RuleResult {
  /** Bitmask of Sig.* */
  sig: number;
  /** Category decided by rules alone (no model needed). */
  cat?: Category;
  /** Explicit user rule outcome — overrides everything except allow > block > highlight order. */
  user?: UserRule['mode'];
  /** Short human readable reason for decided / user verdicts. */
  reason: string;
  /** Never hide / collapse / dim (privileged author, paid, the viewer's own, mentions the viewer, user allow). */
  protect: boolean;
}

/** True when the model's opinion is needed for this message. */
export function needsModel(r: RuleResult): boolean {
  return r.cat === undefined && r.user !== 'block';
}

/** Domains that are never treated as suspicious. Matches the domain and its subdomains. */
export const LINK_ALLOW = [
  'clips.twitch.tv',
  'twitch.tv',
  'kick.com',
  'wikipedia.org',
  'wikimedia.org',
  '7tv.app',
  'betterttv.com',
  'frankerfacez.com',
];

const PRIVILEGED = Role.BROADCASTER | Role.MOD | Role.VIP;

// ───────────────────────────── patterns (compiled once) ─────────────────────────────

const RE_LINK =
  /(?:https?:\/\/|www\.)([a-z0-9.-]+)|\b(t\.me)\/|\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|gg|tv|io|xyz|ru|ly|link|live|shop|store|top|site|online|pro|cc|info|biz|app|fun|club|vip|win|bet|click|su|ua|uk|pl|br))\b(?![\w-]|\.[a-z])/g;
/** "streamboo .com", "dogehype dot com", "site (dot) ru" */
const RE_LINK_OBFUSCATED =
  /\b[a-z0-9-]{3,}\s*(?:\s\.\s*|\.\s+|\(dot\)|\[dot\]|\sdot\s)\s*(?:com|net|org|ru|xyz|gg|io|me|co|tv|shop|store|top|live|online|site|pro|cc|ly)\b/;
/** Strong scam / self-promo patterns, matched on normalized (leet/homoglyph-folded) text. */
const RE_SCAM =
  /\b(?:free|cheap|best|buy|get)\s+(?:robux|v-?bucks|nitro|followers|viewers|primes?|subs|skins|gift\s?cards?)\b|\bfollow\s?(?:for|a|4)?\s?follow\b|\bfaf\b|\bbecome\s+famous\b|\b(?:streamboo|dogehype|viewerboss|bigfollows|streamrise|twitchviews)\b|\b(?:followers|viewers),?\s+(?:and\s+)?(?:primes?|viewers|followers)\b|\bcheck\s+(?:out\s+)?my\s+(?:bio|profile|channel|stream)\b/;
/** Weak scam vocabulary: only a signal. */
const RE_SCAM_WORDS =
  /\b(?:crypto|bitcoin|btc|eth|usdt|airdrop|giveaway|casino|stake|gamdom|promo\s?code|referral|invest(?:ment)?|forex|onlyfans|telegram|whatsapp|dm\s+me|discord\.gg)\b/;
const RE_WS = /\s+/;
const RE_EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s‍️!?.]+$/u;
const RE_CJK = /[⺀-鿿가-힯豈-﫿ｦ-ﾟ]/;

/** Common single-token low-effort reactions (normalized form). */
const NOISE_WORDS = new Set(
  (
    'lol lmao lmfao rofl kekw kek lul lulw omegalul pog pogu poggers pogchamp first f gg ggs ez w l ' +
    'omg wtf bruh true real based rip yes yep yup nope nah yeah yea ok okay kappa xd xdd ' +
    'wow damn sheesh clap ayaya pepega monkas monkaw pepelaugh icant hii hey hi hello yo sup ' +
    'jaja jajaja kkk ahah ahaha haha hahaha hehe hihi xaxa ахах ахаха хаха лол кек ' +
    'o7 +1 +2 -1 nice cool same this facts ratio noo nooo yess lets go letsgo gogo 草 ww www ㅋㅋ ㅋㅋㅋ'
  ).split(' '),
);

// ───────────────────────────── user rules ─────────────────────────────

interface WordRule {
  w: string;
  prefix: boolean;
  substring: boolean;
  mode: UserRule['mode'];
  label: string;
}
interface RegexRule {
  re: RegExp;
  mode: UserRule['mode'];
  label: string;
}

export interface CompiledRules {
  users: Map<string, { mode: UserRule['mode']; label: string }>;
  words: WordRule[];
  regex: RegexRule[];
  errors: { id: string; error: string }[];
}

const MODE_RANK: Record<UserRule['mode'], number> = { allow: 3, block: 2, highlight: 1 };

export function compileRules(rules: UserRule[]): CompiledRules {
  const out: CompiledRules = { users: new Map(), words: [], regex: [], errors: [] };
  for (const r of rules) {
    if (!r.enabled || !r.pattern.trim()) continue;
    const label = r.pattern.trim();
    if (r.kind === 'user') {
      const u = label.replace(/^@/, '').toLowerCase();
      const prev = out.users.get(u);
      if (!prev || MODE_RANK[r.mode] > MODE_RANK[prev.mode]) out.users.set(u, { mode: r.mode, label });
    } else if (r.kind === 'word') {
      let w = label;
      const prefix = w.endsWith('*');
      if (prefix) w = w.slice(0, -1);
      w = wordText(normalize(w)).trim();
      if (!w) continue;
      out.words.push({ w, prefix, substring: RE_CJK.test(w), mode: r.mode, label });
    } else {
      try {
        out.regex.push({ re: new RegExp(r.pattern, 'iu'), mode: r.mode, label });
      } catch (e) {
        out.errors.push({ id: r.id, error: String((e as Error).message ?? e) });
      }
    }
  }
  // Evaluate stronger modes first so the first hit wins.
  out.words.sort((a, b) => MODE_RANK[b.mode] - MODE_RANK[a.mode]);
  out.regex.sort((a, b) => MODE_RANK[b.mode] - MODE_RANK[a.mode]);
  return out;
}

const RE_NON_WORD = /[^\p{L}\p{N}\p{M}@#'\s]+/gu;

/** Normalized text with punctuation turned into spaces (word boundaries for word rules). */
function wordText(norm: string): string {
  return norm.replace(RE_NON_WORD, ' ');
}

function isNameChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c >= 0x80;
}

function matchUserRules(
  c: CompiledRules,
  msg: ChatMessage,
  norm: string,
): { mode: UserRule['mode']; label: string; kind: string } | null {
  let best: { mode: UserRule['mode']; label: string; kind: string } | null = null;
  if (c.users.size) {
    const u = c.users.get(msg.author.toLowerCase()) ?? (msg.authorId ? c.users.get(msg.authorId.toLowerCase()) : undefined);
    if (u) {
      if (u.mode === 'allow') return { ...u, kind: 'user' };
      best = { ...u, kind: 'user' };
    }
  }
  if (c.words.length) {
    const padded = ' ' + wordText(norm) + ' ';
    for (const w of c.words) {
      if (best && MODE_RANK[w.mode] <= MODE_RANK[best.mode]) break;
      const hit = w.substring
        ? norm.includes(w.w)
        : w.prefix
          ? padded.includes(' ' + w.w)
          : padded.includes(' ' + w.w + ' ');
      if (hit) {
        best = { mode: w.mode, label: w.label, kind: 'word' };
        break;
      }
    }
  }
  if (c.regex.length && (!best || best.mode !== 'allow')) {
    for (const r of c.regex) {
      if (best && MODE_RANK[r.mode] <= MODE_RANK[best.mode]) break;
      if (r.re.test(msg.text)) {
        best = { mode: r.mode, label: r.label, kind: 'regex' };
        break;
      }
    }
  }
  return best;
}

// ───────────────────────────── engine ─────────────────────────────

export interface RuleEngineOptions {
  /** Same user + same normalized text within this window → spam. */
  dupWindowMs?: number;
  /** Max authors tracked for duplicate detection (LRU). */
  maxUsers?: number;
  /** Extra always-allowed link domains. */
  linkAllow?: string[];
}

interface UserHistory {
  texts: string[];
  ts: number[];
  /** Key of the message that posted each text first. */
  keys: string[];
}

const DUP_SLOTS = 4;

function hostAllowed(host: string, allow: string[]): boolean {
  for (const d of allow) {
    if (host === d || (host.length > d.length && host.endsWith(d) && host.charCodeAt(host.length - d.length - 1) === 0x2e))
      return true;
  }
  return false;
}

function isWordStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c >= 0xc0;
}

/** `name` (any case, no "@") is one of the viewer's names (lowercased). */
function isViewerName(viewer: readonly string[], name: string): boolean {
  for (const v of viewer) if (name.length === v.length && name.toLowerCase() === v) return true;
  return false;
}

export class RuleEngine {
  private compiled: CompiledRules = compileRules([]);
  private trustPrivileged = true;
  /** Names the signed-in viewer goes by (login, display name), lowercased. */
  private viewer: string[] = [];
  private history: LRU<string, UserHistory>;
  private dupWindowMs: number;
  private linkAllow: string[];

  constructor(opts: RuleEngineOptions = {}) {
    this.dupWindowMs = opts.dupWindowMs ?? 30_000;
    this.history = new LRU(opts.maxUsers ?? 4096);
    this.linkAllow = [...LINK_ALLOW, ...(opts.linkAllow ?? [])];
  }

  setSettings(s: Pick<Settings, 'rules' | 'trustPrivileged'>): void {
    this.compiled = compileRules(s.rules);
    this.trustPrivileged = s.trustPrivileged;
  }

  get ruleErrors(): CompiledRules['errors'] {
    return this.compiled.errors;
  }

  setViewer(names: string | readonly string[] | null | undefined): void {
    const viewer: string[] = [];
    for (const n of typeof names === 'string' ? [names] : (names ?? [])) {
      const v = n.trim().replace(/^@/, '').toLowerCase();
      if (v && !viewer.includes(v)) viewer.push(v);
    }
    this.viewer = viewer;
  }

  reset(): void {
    this.history.clear();
  }

  /**
   * Evaluate one message. `norm` must be `normalize(msg.text)`.
   * `knownDup` — pass the previous DUPLICATE outcome when re-evaluating a
   * message (settings change) so the duplicate tracker isn't fed twice.
   */
  evaluate(msg: ChatMessage, norm: string, now: number, knownDup?: boolean): RuleResult {
    let sig = 0;
    let protect = false;
    const text = msg.text;

    if (msg.roles & PRIVILEGED) {
      sig |= Sig.PRIVILEGED;
      if (this.trustPrivileged) protect = true;
    }
    if (msg.paid) {
      sig |= Sig.PAID;
      protect = true;
    }
    if (msg.isFirstMessage) sig |= Sig.FIRST;

    let lower: string | null = null;
    const viewer = this.viewer;
    if (viewer.length) {
      if (isViewerName(viewer, msg.author) || (msg.authorId && isViewerName(viewer, msg.authorId))) {
        sig |= Sig.OWN;
        protect = true;
      } else {
        let hit = false;
        for (const m of msg.mentions) {
          if (isViewerName(viewer, m.charCodeAt(0) === 0x40 ? m.slice(1) : m)) {
            hit = true;
            break;
          }
        }
        if (!hit && text.indexOf('@') >= 0) {
          lower = text.toLowerCase();
          for (const v of viewer) {
            const at = lower.indexOf('@' + v);
            if (at >= 0 && !isNameChar(lower.charCodeAt(at + 1 + v.length))) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          sig |= Sig.MENTIONS_VIEWER;
          protect = true;
        }
      }
    }

    // ── explicit user rules
    const c = this.compiled;
    if (c.users.size || c.words.length || c.regex.length) {
      const hit = matchUserRules(c, msg, norm);
      if (hit) {
        const reason = hit.mode === 'allow' ? `allowed: ${hit.label}` : hit.mode === 'block' ? `blocked: ${hit.label}` : `rule: ${hit.label}`;
        return { sig, user: hit.mode, reason, protect: protect || hit.mode === 'allow' };
      }
    }

    // ── !command
    if (norm.charCodeAt(0) === 0x21 && norm.length > 1 && isWordStart(norm.charCodeAt(1))) {
      return { sig: sig | Sig.COMMAND, cat: 'noise', reason: '!command', protect };
    }

    // ── duplicate by the same author (the viewer asking again is not spam)
    const dup = knownDup ?? (!(sig & Sig.OWN) && this.trackDuplicate(msg, norm, now));
    if (dup) {
      return { sig: sig | Sig.DUPLICATE, cat: 'spam', reason: 'repeat', protect };
    }

    // ── raw scan: char runs, caps, ascii art, '?'
    const len = text.length;
    let run = 1;
    let maxRun = 1;
    let prev = -1;
    let upper = 0;
    let letters = 0;
    let art = 0;
    let q = false;
    let rawTok = 0;
    let inTok = false;
    for (let i = 0; i < len; i++) {
      const ch = text.charCodeAt(i);
      if (ch <= 0x20 || ch === 0xa0 || ch === 0x3000) inTok = false;
      else if (!inTok) {
        inTok = true;
        rawTok++;
      }
      if (ch === prev) {
        if (++run > maxRun) maxRun = run;
      } else {
        prev = ch;
        run = 1;
      }
      if (ch < 0x80) {
        if (ch >= 0x41 && ch <= 0x5a) {
          upper++;
          letters++;
        } else if (ch >= 0x61 && ch <= 0x7a) letters++;
        else if (ch === 0x3f) q = true;
      } else if (ch >= 0x410 && ch <= 0x44f) {
        letters++;
        if (ch < 0x430) upper++;
      } else if (ch >= 0x391 && ch <= 0x3c9) {
        letters++;
        if (ch <= 0x3a9) upper++;
      } else if ((ch >= 0x2500 && ch <= 0x259f) || (ch >= 0x2800 && ch <= 0x28ff)) art++;
      else if (ch === 0xff1f || ch === 0xbf) q = true;
    }
    if (q) sig |= Sig.QUESTION_MARK;
    if (letters >= 12 && upper >= letters * 0.7) sig |= Sig.CAPS;

    if (art >= 16) return { sig: sig | Sig.ASCII_ART, cat: 'spam', reason: 'ascii art', protect };
    if (maxRun >= 16) return { sig: sig | Sig.CHAR_FLOOD, cat: 'spam', reason: 'char flood', protect };
    if (msg.emotes >= 10) return { sig: sig | Sig.EMOTE_FLOOD, cat: 'spam', reason: `emotes ×${msg.emotes}`, protect };

    // ── token stats (raw tokens; normalized text collapses repeats)
    const ntok = tokenCount(norm);
    if (rawTok >= 6) {
      const toks = text.trim().split(RE_WS);
      const distinct = new Set<string>();
      for (const t of toks) distinct.add(t.toLowerCase());
      const d = distinct.size;
      if ((rawTok >= 8 && d <= 2) || (rawTok >= 16 && d * 4 <= rawTok))
        return { sig: sig | Sig.REPEAT, cat: 'spam', reason: `repeat ×${rawTok}`, protect };
      if (d * 3 <= rawTok) sig |= Sig.REPEAT;
    }

    // ── emote-only / emoji-only
    if ((msg.emotes > 0 && rawTok <= msg.emotes) || (norm.length > 0 && norm.length <= 40 && !hasAsciiAlnum(norm) && RE_EMOJI_ONLY.test(norm))) {
      return { sig: sig | Sig.EMOTE_ONLY, cat: 'noise', reason: 'emote only', protect };
    }

    // ── links
    if (maybeLink(text)) {
      lower ??= text.toLowerCase();
      const linkSig = this.scanLinks(lower, msg.roles);
      sig |= linkSig;
    }

    // ── scam patterns (normalized text: leet / homoglyph folded)
    if (norm.length >= 6) {
      if (RE_SCAM.test(norm)) return { sig: sig | Sig.SCAM_PATTERN, cat: 'scam', reason: 'scam pattern', protect };
      if (RE_SCAM_WORDS.test(norm)) sig |= Sig.SCAM_WORDS;
    }
    if (sig & Sig.LINK && sig & (Sig.SCAM_WORDS | Sig.FIRST))
      return { sig, cat: 'scam', reason: sig & Sig.FIRST ? 'link · first message' : 'link · scam words', protect };

    // ── trivially short / reactions ("W", "lol", "hahaha", "LETS GO", "ok ok")
    if (ntok <= 4 && !(sig & (Sig.LINK | Sig.LINK_OK))) {
      if (ntok === 1 ? isShortNoise(norm) : !(sig & Sig.QUESTION_MARK) && allShortNoise(norm))
        return { sig: sig | Sig.SHORT, cat: 'noise', reason: 'short', protect };
    }

    return { sig, reason: '', protect };
  }

  private trackDuplicate(msg: ChatMessage, norm: string, now: number): boolean {
    if (!norm) return false;
    const who = msg.authorId || msg.author.toLowerCase();
    let h = this.history.get(who);
    if (!h) {
      h = { texts: [], ts: [], keys: [] };
      this.history.set(who, h);
    }
    const win = this.dupWindowMs;
    let dup = false;
    for (let i = 0; i < h.texts.length; i++) {
      if (h.texts[i] === norm && now - h.ts[i]! <= win) {
        // the same message seen again (row re-mounted, Hush turned off and on) is no repeat
        if (h.keys[i] === msg.key) return false;
        dup = true;
        h.ts[i] = now;
        break;
      }
    }
    if (!dup) {
      if (h.texts.length >= DUP_SLOTS) {
        h.texts.shift();
        h.ts.shift();
        h.keys.shift();
      }
      h.texts.push(norm);
      h.ts.push(now);
      h.keys.push(msg.key);
    }
    return dup;
  }

  private scanLinks(lower: string, roles: number): number {
    let found = false;
    let untrusted = false;
    RE_LINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_LINK.exec(lower))) {
      const host = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^www\./, '').replace(/\.$/, '');
      if (!host || host.indexOf('.') < 0) continue;
      found = true;
      if (!hostAllowed(host, this.linkAllow)) untrusted = true;
    }
    if (!found && RE_LINK_OBFUSCATED.test(lower)) {
      found = true;
      untrusted = true;
    }
    if (!found) return 0;
    if (!untrusted || roles & PRIVILEGED) return Sig.LINK_OK;
    return Sig.LINK;
  }
}

function allShortNoise(norm: string): boolean {
  for (const t of norm.split(' ')) if (!isShortNoise(t)) return false;
  return true;
}

function hasAsciiAlnum(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return true;
  }
  return false;
}

function isAlnum(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
}

/** Cheap gate before the link regexes: "x.y" with alnum on both sides, "://", or " dot ". */
function maybeLink(t: string): boolean {
  let i = t.indexOf('.');
  while (i >= 0) {
    if (i > 0 && isAlnum(t.charCodeAt(i - 1)) && isAlnum(t.charCodeAt(i + 1))) return true;
    // obfuscated "site .com" / "site. com"
    if (t.charCodeAt(i - 1) === 0x20 || t.charCodeAt(i + 1) === 0x20) {
      const c = t.charCodeAt(i + 1) === 0x20 ? t.charCodeAt(i + 2) : t.charCodeAt(i + 1);
      if (isAlnum(c)) return true;
    }
    i = t.indexOf('.', i + 1);
  }
  return t.indexOf('://') >= 0 || t.indexOf(' dot ') >= 0 || t.indexOf('(dot)') >= 0 || t.indexOf('[dot]') >= 0;
}

function isShortNoise(norm: string): boolean {
  const n = norm.length;
  if (n === 0) return true;
  if (NOISE_WORDS.has(norm)) return true;
  const cjk = RE_CJK.test(norm);
  if (cjk) return n <= 1;
  if (n <= 2) return true;
  // numbers / punctuation only ("1", "69", "???", "+1")
  let alpha = false;
  let a = -1;
  let b = -1;
  let distinct = 0;
  for (let i = 0; i < n; i++) {
    const ch = norm.charCodeAt(i);
    if ((ch >= 0x61 && ch <= 0x7a) || ch >= 0xc0) alpha = true;
    if (ch !== a && ch !== b) {
      distinct++;
      if (distinct > 2) break;
      if (a < 0) a = ch;
      else b = ch;
    }
  }
  if (!alpha) return n <= 8;
  // laughter / single-syllable spam: "hahaha", "kkkk", "ахахах" → ≤ 2 distinct chars
  return distinct <= 2;
}
