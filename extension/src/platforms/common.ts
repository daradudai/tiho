// Small helpers shared by the platform adapters. Everything here is on the
// per-message hot path, so: no allocations beyond the result, no layout reads,
// no innerText.

import { fnv1a } from '../core/hash';

/** Mutable accumulator filled by the per-platform text walkers. */
export interface TextAcc {
  text: string;
  emotes: number;
  mentions: string[];
}

export function newAcc(): TextAcc {
  return { text: '', emotes: 0, mentions: [] };
}

/** Append an emote code to the text with word boundaries. */
export function pushEmote(acc: TextAcc, code: string): void {
  acc.emotes++;
  if (!code) return;
  const t = acc.text;
  if (t.length && t.charCodeAt(t.length - 1) !== 32) acc.text = t + ' ' + code + ' ';
  else acc.text = t + code + ' ';
}

/** Strip a leading "@" and surrounding whitespace / punctuation from a name. */
export function cleanName(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) <= 32 || s.charCodeAt(a) === 64 /* @ */)) a++;
  while (b > a && (s.charCodeAt(b - 1) <= 32 || s.charCodeAt(b - 1) === 58 /* : */ || s.charCodeAt(b - 1) === 44)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

export function addMention(acc: TextAcc, name: string): void {
  const n = cleanName(name);
  if (n && !acc.mentions.includes(n)) acc.mentions.push(n);
}

// Unicode-aware @handle: letters, digits, marks, _ . - (YouTube handles allow . and -).
const MENTION_RE = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}\p{M}_][\p{L}\p{N}\p{M}_.\-]*)/gu;

/** Collect @mentions from plain text (only scans when the text contains "@"). */
export function mentionsFromText(acc: TextAcc): void {
  const t = acc.text;
  if (t.indexOf('@') < 0) return;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(t))) {
    let n = m[1]!;
    // trailing dots / dashes are punctuation, not part of the handle
    while (n.length && (n.endsWith('.') || n.endsWith('-'))) n = n.slice(0, -1);
    if (n && !acc.mentions.includes(n)) acc.mentions.push(n);
  }
}

/** Collapse runs of whitespace (incl. NBSP / zero-width joiners left by emote spacing) and trim. */
export function tidy(s: string): string {
  // fast path: nothing to do
  let needs = false;
  const n = s.length;
  if (n === 0) return s;
  if (s.charCodeAt(0) <= 32 || s.charCodeAt(n - 1) <= 32) needs = true;
  else
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 0xa0 || c === 0x200b || c === 0xfeff || c === 9 || c === 10 || c === 13 || (c === 32 && s.charCodeAt(i + 1) === 32)) {
        needs = true;
        break;
      }
    }
  if (!needs) return s;
  return s.replace(/[​﻿]/g, '').replace(/[\s ]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Keys

const nodeKeys = new WeakMap<Element, string>();
const seen = new Map<string, number>();

/**
 * Stable key for a row that has no platform message id: hash of the given
 * content parts plus an occurrence ordinal (so two identical "LUL" from the
 * same user get different keys). Memoized per DOM node, so re-extracting the
 * same node returns the same key.
 */
export function contentKey(prefix: string, row: Element, a: string, b: string, c = ''): string {
  const k = nodeKeys.get(row);
  if (k) return k;
  const h = fnv1a(c, fnv1a(b, fnv1a(a + '\u0001')));
  const base = prefix + h.toString(36);
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  if (seen.size > 20000) seen.clear();
  const key = n ? base + '.' + n : base;
  nodeKeys.set(row, key);
  return key;
}

/** Deterministic key (no ordinal): the same content always maps to the same key. */
export function stableKey(prefix: string, a: string, b: string, c = ''): string {
  return prefix + fnv1a(c, fnv1a(b, fnv1a(a + '\u0001'))).toString(36);
}

const lastByKey = new Map<string, Element>();

/**
 * Key for VIRTUALIZED lists (Kick), where a message's row is unmounted when it
 * scrolls out and re-mounted as a NEW node when scrolled back:
 *  - re-mount (the previous node with this content is detached) → SAME key
 *  - genuine duplicate (another node with this content is still mounted, e.g.
 *    the same user spamming the same text within the minute) → ordinal key.
 * Memoized per node. Keeps strong refs to at most 512 recent rows.
 */
export function remountKey(prefix: string, row: Element, a: string, b: string, c = ''): string {
  const memo = nodeKeys.get(row);
  if (memo) return memo;
  const base = stableKey(prefix, a, b, c);
  let key = base;
  for (let n = 1; n < 64; n++) {
    const prev = lastByKey.get(key);
    if (!prev || prev === row || !prev.isConnected) break;
    key = base + '.' + n;
  }
  lastByKey.delete(key);
  lastByKey.set(key, row);
  if (lastByKey.size > 512) lastByKey.delete(lastByKey.keys().next().value!);
  nodeKeys.set(row, key);
  return key;
}

// ---------------------------------------------------------------------------
// Theme fallback

/** Theme from the computed background luminance of `el` (not hot path). */
export function themeFromBackground(el: Element | null): 'dark' | 'light' | null {
  if (!el) return null;
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  const bg = view.getComputedStyle(el).backgroundColor;
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/.exec(bg || '');
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null; // transparent
  const lum = 0.2126 * +m[1]! + 0.7152 * +m[2]! + 0.0722 * +m[3]!;
  return lum < 128 ? 'dark' : 'light';
}

/** First path segment of a URL path, lowercased ("" for "/"). */
export function firstSegment(pathname: string): string {
  const p = pathname.split('/');
  return (p[1] ?? '').toLowerCase();
}
