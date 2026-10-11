// Message decorations: the visual layer for chat rows. The runtime injects it
// into the chat document (light DOM of the platform page / chat iframe) as its
// one row stylesheet (src/runtime/styles.ts); the onboarding demo and the UI
// showcase use it on their own (writing the same attributes, run marks included).
//
// Row attributes (contract with src/runtime/engine.ts):
//   data-tiho-a     show | highlight | dim | collapse | hide | pending
//   data-tiho-c     toxic | scam | spam | noise | negative | question | positive | clean
//   data-tiho-r     short reason ("toxic · 94%", "link")                    → hover chip
//   data-tiho-wh    wave head, live count ("37")                            → "×37" badge
//   data-tiho-wm    wave member (folds into its head, takes no space)
//   data-tiho-run   on the LAST collapsed row of a run: run length ("3")    → "3 hidden · show"
//                   (the runtime also makes that row a button: tabindex, role, aria-label)
//   data-tiho-open  user expanded a collapsed row
//
// Performance (measured in tests/stress): every selector is a compound of
// plain attribute selectors on the row itself (plus :hover, :focus-visible,
// and :dir(rtl) for the mirrored rules of right-to-left chats), so Blink only
// ever matches rows that carry data-tiho-* and never walks ancestors or
// siblings: no row selector scoping (:is(<rows>)), no sibling (+) combinators,
// no CSS counters, no transitions on rows. Collapsed rows take no space
// (display:none) except the one the runtime marks with data-tiho-run, which
// becomes the pill; the runtime keeps that mark in O(changed rows). The one
// child (>) rule hides the pill row's own content, so that the row can stay
// visible and take keyboard focus.
//
// Modes and views. Basic mode draws no category edges and no reason chips.
// Show hidden (peek) and Solo are views of one tab: each is a variant of the
// whole sheet (a later rule could not undo display:none!important), swapped
// in one text change, with no write on any row. Show hidden brings hidden
// and folded rows back in place, faded, with a dashed edge in their category
// color, and draws no pills (so it has no child rule either). Solo hides
// every row of another category and shows the chosen one's in full, each
// with a solid edge (dashed: normally not shown). In both, a row's tag (its
// reason and what it normally gets: "spam · 97% · folded") shows only while
// the row is pointed at, as an out-of-flow chip like the reason chip: the
// views never change a row's layout (same lines, same height). Wave members
// stay folded in both.
//
// Everything visual is driven by --tiho-* custom properties declared with
// zero specificity, so a theme can override them from anywhere, e.g.
//   document.documentElement.style.setProperty('--tiho-c-toxic', '#f00')

import type { UiMode } from '../core/settings';
import { ALWAYS_SHOWN, type Action, type Category, type Platform } from '../core/types';
import { BRAND, CATEGORY_META, type Theme } from './tokens';

interface PlatformDeco {
  /** Left inset of the pill so it lines up with message text. */
  indent: string;
  /** Margin of the "×37" wave badge (floated into the row's top-right corner; a trailing item on flex rows). */
  wave: string;
  /**
   * Rows are positioned already (Kick's virtual list: absolute rows), so the
   * hover chip anchors to them as they are. Elsewhere the hovered row becomes
   * position:relative (no offsets: nothing moves) to anchor the chip.
   */
  positioned: boolean;
  /**
   * The list mounts only the rows near the viewport and places them from
   * their measured heights (Kick). It measures a row as it mounts, before
   * Tiho has written anything on it, and again whenever its size changes. A
   * row born at full height that Tiho then hides shrinks, which pulls more
   * rows into the list, each born at full height again: with many rows
   * hidden or folded (Quiet, Solo, Clean in a spammy chat) Kick mounted and
   * unmounted 350 to 800 rows a second and fell below 20 fps (measured live).
   * So there a row with no verdict yet takes no space (virtualList): its
   * verdict can only make it grow, and a row that grows only pushes rows out
   * of the list, so the list settles.
   */
  virtual: boolean;
}

const PLATFORM_DECO: Record<Platform, PlatformDeco> = {
  // row > div > .chat-line__message (padding 5px 20px, 20px lines)
  twitch: { indent: '20px', wave: '6px 10px 0 6px', positioned: false, virtual: false },
  // yt-live-chat-text-message-renderer: flex row, padding 4px 24px, 16px lines
  youtube: { indent: '24px', wave: '3px 0 0 8px', positioned: false, virtual: false },
  // div[data-index] (absolute) > .px-2 > .px-2 (padding-block 4px, ~22px lines)
  kick: { indent: '16px', wave: '6px 12px 0 6px', positioned: true, virtual: true },
};

const THEME_DECO: Record<Theme, Record<string, string>> = {
  dark: {
    'pill-fill': 'rgba(255,255,255,0.055)',
    'pill-line': 'rgba(255,255,255,0.08)',
    'pill-fg': '#a3a3b2',
    'pill-hover': 'rgba(255,255,255,0.11)',
    'tip-bg': '#26262f',
    'tip-fg': '#f4f4f8',
    'tip-line': 'rgba(255,255,255,0.12)',
    'tip-shadow': '0 4px 14px -2px rgba(0,0,0,0.55)',
    'wave-bg': 'rgba(132,135,255,0.16)',
    'hl-mix': '15%',
    dim: '0.38',
  },
  light: {
    'pill-fill': 'rgba(16,16,40,0.045)',
    'pill-line': 'rgba(16,16,40,0.09)',
    'pill-fg': '#62626f',
    'pill-hover': 'rgba(16,16,40,0.09)',
    'tip-bg': '#1d1d24',
    'tip-fg': '#f6f6f8',
    'tip-line': 'rgba(255,255,255,0.06)',
    'tip-shadow': '0 4px 14px -2px rgba(16,16,40,0.3)',
    'wave-bg': 'rgba(79,82,224,0.1)',
    'hl-mix': '11%',
    dim: '0.42',
  },
};

/** Opacity of the quiet category edge, as a hex alpha appended to the category color. */
const EDGE_ALPHA: Record<Theme, string> = { dark: '9e', light: 'b3' };

/** Categories with an accent color (`clean` has none). */
const ACCENTED = ['toxic', 'scam', 'spam', 'noise', 'negative', 'question', 'positive'] as const;
/** Categories that get the quiet left edge when shown / dimmed (noise would stripe half the chat). */
const EDGED = ['toxic', 'scam', 'spam', 'negative', 'question', 'positive'] as const;

/**
 * What a hidden row's tag says in Basic's Show hidden ("Hidden · insult"):
 * plain words, no categories. Positive and clean rows are hidden only by
 * rules or filters, and say just "Hidden".
 */
const PLAIN_WORD: Partial<Record<Category, string>> = {
  toxic: 'insult',
  scam: 'scam',
  spam: 'spam',
  noise: 'one-word reply',
  negative: 'complaint',
  question: 'question',
};

/** What a row normally gets, by data-tiho-a, as Solo's tag says it. */
const DID: Record<Action, string> = { show: 'shown', highlight: 'highlighted', dim: 'dimmed', collapse: 'folded', hide: 'hidden' };

/**
 * The box of a chip that shows on a pointed-at row (the reason chip, a view's
 * tag): a small tooltip straddling the row's top edge, out of flow. See the
 * reason chip's comment in decorationCss for where it sits and why.
 */
const CHIP = `
  display:block;position:absolute;top:auto;right:44px;bottom:calc(100% - 8px);left:auto;z-index:5;float:none;order:0;
  height:16px;max-width:calc(100% - 64px);margin:0;padding:0 7px 0 15px;border:0;border-radius:999px;box-sizing:border-box;overflow:hidden;
  font-size:10px;font-weight:600;font-style:normal;line-height:16px;letter-spacing:.015em;text-overflow:ellipsis;white-space:nowrap;text-transform:none;
  color:var(--tiho-tip-fg);
  background:radial-gradient(circle at 8px 50%,var(--tiho-accent,var(--tiho-link)) 0 2.5px,transparent 3.1px),var(--tiho-tip-bg);
  box-shadow:var(--tiho-tip-shadow),inset 0 0 0 1px var(--tiho-tip-line);
  pointer-events:none;
  animation:tiho-tip-in 120ms cubic-bezier(.2,.8,.2,1) 180ms both`;
/** The same chip in a right-to-left chat: from the left, its dot on the right. */
const CHIP_RTL = `
  right:auto;left:44px;padding:0 15px 0 7px;direction:ltr;
  background:radial-gradient(circle at calc(100% - 8px) 50%,var(--tiho-accent,var(--tiho-link)) 0 2.5px,transparent 3.1px),var(--tiho-tip-bg)`;
const CHIP_IN = '@keyframes tiho-tip-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}';

export interface DecorationOptions {
  /** settings.decorate: category edges, highlight glow, reveal marks and reason chips. Hide/dim/collapse/highlight always apply. */
  decorate?: boolean;
  /** Basic draws no category edges and no reason chips, whatever `decorate` says (default 'advanced'). */
  mode?: UiMode;
  /** Show hidden: hidden and folded rows come back in place, faded and tagged with why (no pills). */
  peek?: boolean;
  /** Solo: every other category's rows are hidden; this one's show in full, each tagged with its reason and normal action. Wins over peek. */
  solo?: Category | null;
  /** Ignored (kept for compatibility): selectors are attribute-only, see the header. */
  rowSelector?: string;
}

/**
 * data-tiho-run values for a static list of rows, given each row's action (for
 * pages that write the attributes themselves, like the onboarding demo): the
 * last collapsed row of each run gets the run's length, every other row
 * nothing. Hidden rows take no space and do not break a run, as in the runtime.
 */
export function pillRuns(actions: readonly string[]): (string | undefined)[] {
  const out: (string | undefined)[] = actions.map(() => undefined);
  let n = 0;
  let last = -1;
  actions.forEach((a, i) => {
    if (a === 'hide') return;
    if (a === 'collapse') {
      n++;
      last = i;
      return;
    }
    if (n) out[last] = String(n);
    n = 0;
  });
  if (n) out[last] = String(n);
  return out;
}

/** The platform's chat list is virtual: a row with no verdict yet must take no space there (see PlatformDeco.virtual). */
export function virtualList(platform: Platform | string): boolean {
  return (PLATFORM_DECO[platform as Platform] ?? PLATFORM_DECO.twitch).virtual;
}

export function decorationCss(platform: Platform | string, theme: Theme, opts: DecorationOptions = {}): string {
  const p = PLATFORM_DECO[platform as Platform] ?? PLATFORM_DECO.twitch;
  const t = THEME_DECO[theme];
  const decorate = opts.decorate ?? true;
  const accent = BRAND.accent[theme];
  const basic = opts.mode === 'basic';
  const solo = opts.solo ?? null;
  const peek = !solo && !!opts.peek;
  /** The usual view: hidden rows gone, folded runs drawn as pills. */
  const plain = !solo && !peek;
  /** Category edges and reason chips: Advanced only, and never in Solo (its marker and tag say more). */
  const hints = decorate && !basic && !solo;

  const vars = [
    ...ACCENTED.map((c) => {
      const color = CATEGORY_META[c].color[theme];
      return `--tiho-c-${c}:${color};--tiho-e-${c}:${color}${EDGE_ALPHA[theme]};`;
    }),
    `--tiho-c-highlight:${accent};--tiho-link:${accent};--tiho-wave-fg:${accent};`,
    ...Object.entries(t).map(([k, v]) => `--tiho-${k}:${v};`),
    `--tiho-indent:${p.indent};--tiho-edge-w:2px;`,
  ].join('');

  // A collapsed row that is not expanded; RUN is the one that draws the run's pill.
  const COL = '[data-tiho-a="collapse"]:not([data-tiho-open])';
  const RUN = '[data-tiho-run][data-tiho-a="collapse"]:not([data-tiho-open])';
  const HIDE = '[data-tiho-a="hide"]';
  const WM = '[data-tiho-wm]:not([data-tiho-open])';
  const SHOWN = ['[data-tiho-a="show"]', '[data-tiho-a="dim"]', '[data-tiho-a="highlight"]'];
  const RTL = ':dir(rtl)';
  const list = (sels: string[], suffix = '') => sels.map((s) => s + suffix).join(',');
  // The pill's outline: each half draws it on its three outer sides (its left or right, top, bottom).
  const ring = (side: 'left' | 'right', w: string, color: string) =>
    `box-shadow:inset ${side === 'left' ? w : `-${w}`} 0 0 ${color},inset 0 ${w} 0 ${color},inset 0 -${w} 0 ${color}`;
  const LINE = 'var(--tiho-pill-line)';
  const FOCUS = 'var(--tiho-link)';
  // The dashed edge of a row the viewer opened; in the views it also marks "normally not shown".
  const DASHED = `box-shadow:none!important;
  background-image:linear-gradient(var(--tiho-accent,var(--tiho-c-noise)) 50%,transparent 50%)!important;
  background-size:2px 6px!important;background-repeat:repeat-y!important;background-position:0 0!important`;

  // Show hidden and Solo are variants of this sheet, not rules on top of it:
  // nothing could undo a display:none!important that is already there.
  const X = solo ? `[data-tiho-c="${solo}"]` : '';
  const gone = plain ? [HIDE, WM, `${COL}:not([data-tiho-run])`] : solo ? [WM, `[data-tiho-c]:not(${X})`] : [WM];
  /** Rows that carry a view's tag (::after, on hover), and rows that get the dashed "normally not shown" edge. */
  const tagged = solo ? [X] : peek ? [HIDE, COL] : [];
  const marked = solo ? [X + HIDE, X + COL] : tagged;
  // Solo shows its category in full: nothing is dimmed
  const dim = solo ? '' : '[data-tiho-a="dim"]{opacity:var(--tiho-dim)!important}\n[data-tiho-a="dim"]:hover{opacity:1!important}\n';

  let css = `
:where(:root,:host){${vars}}
${ACCENTED.map((c) => `[data-tiho-c="${c}"]{--tiho-accent:var(--tiho-c-${c});--tiho-edge:var(--tiho-e-${c})}`).join('\n')}

[data-tiho-a="pending"]{visibility:hidden!important}
${gone.join(',')}{display:none!important}
${dim}[data-tiho-a="highlight"]{background-color:color-mix(in srgb,var(--tiho-accent,var(--tiho-c-highlight)) var(--tiho-hl-mix),transparent)!important;box-shadow:inset 3px 0 0 var(--tiho-accent,var(--tiho-c-highlight))!important}
`;

  if (plain)
    css += `
/* The last row of a collapsed run is the pill ("3 hidden · show"). Its own
   content stays laid out but invisible and clipped; the pill halves come
   first and sit at the top, however tall the hidden content next to them.
   The row itself stays visible, since a hidden box cannot take keyboard focus
   (the runtime makes the pill a button): its children are hidden instead, the
   one rule that looks below a row, and text right in the row is transparent. */
${RUN}{
  display:flex!important;flex-wrap:wrap!important;align-items:flex-start!important;align-content:flex-start!important;
  box-sizing:border-box!important;height:26px!important;min-height:0!important;max-height:26px!important;
  margin:0!important;padding:3px 8px 3px var(--tiho-indent)!important;border:0!important;border-radius:0!important;
  overflow:hidden!important;visibility:visible!important;opacity:1!important;color:transparent!important;
  background:none!important;box-shadow:none!important;cursor:pointer!important}
${RUN}>*{visibility:hidden!important}
${RUN}::before,${RUN}::after{
  display:block;flex:none;align-self:flex-start;height:20px;box-sizing:border-box;margin:0;border:0;
  font-size:11px;font-style:normal;line-height:20px;letter-spacing:.01em;white-space:pre;text-transform:none;
  background-color:var(--tiho-pill-fill)}
${RUN}::before{
  order:-2;content:attr(data-tiho-run) " hidden";
  padding:0 5px 0 18px;border-radius:999px 0 0 999px;
  font-weight:500;font-variant-numeric:tabular-nums;color:var(--tiho-pill-fg);
  background-image:radial-gradient(circle at 9.5px 50%,var(--tiho-accent,var(--tiho-c-noise)) 0 3px,transparent 3.6px);
  ${ring('left', '1px', LINE)}}
${RUN}::after{
  order:-1;content:"·  show";
  padding:0 10px 0 0;border-radius:0 999px 999px 0;
  font-weight:600;color:var(--tiho-link);
  ${ring('right', '1px', LINE)}}
${RUN}:hover::before,${RUN}:hover::after,${RUN}:focus-visible::before,${RUN}:focus-visible::after{background-color:var(--tiho-pill-hover)}
/* Keyboard focus: the pill's outline turns 2px, in the link color. The row's
   own outline stays transparent, so that forced-colors mode still shows one. */
${RUN}:focus-visible{outline:2px solid transparent!important;outline-offset:-2px!important}
${RUN}:focus-visible::before{${ring('left', '2px', FOCUS)}}
${RUN}:focus-visible::after{${ring('right', '2px', FOCUS)}}
`;

  css += `
/* Wave head: "×37" floated into the row's top-right corner, so the text wraps
   around it instead of under it (on flex rows: a trailing item, same place). */
${list(SHOWN.map((s) => `[data-tiho-wh]${s}`), '::before')}{
  content:"×" attr(data-tiho-wh);float:right;order:9;align-self:flex-start;position:static;
  display:block;height:18px;margin:${p.wave};padding:0 7px;border-radius:999px;
  font-size:11px;font-weight:650;font-style:normal;line-height:18px;letter-spacing:.01em;font-variant-numeric:tabular-nums;white-space:nowrap;
  color:var(--tiho-wave-fg);background:var(--tiho-wave-bg)}
`;

  if (tagged.length) {
    const pointed = tagged.flatMap((s) => [`${s}:hover`, `${s}:focus-within`]);
    css += `
/* A view's marker: a thin edge in the row's category color, solid when the row
   is normally shown (Solo), dashed when it is normally hidden or folded. It is
   a box-shadow or background, so the row keeps the platform's layout exactly
   (same line count, same height: Kick's virtual rows never change size). */
${solo ? `${X}{box-shadow:inset var(--tiho-edge-w) 0 0 var(--tiho-accent,var(--tiho-pill-fg))!important}
` : ''}${list(marked)}{
  ${DASHED}}
/* Its tag ("spam · 97% · folded") shows only while the row is pointed at or
   holds focus: the reason chip's box and place (above the row's top-right
   edge, out of flow), so nothing reflows. */
${list(tagged, '::after')}{display:none}
${p.positioned ? '' : `${pointed.join(',')}{position:relative}`}
${list(pointed, '::after')}{${CHIP}}
${CHIP_IN}
@media (prefers-reduced-motion:reduce){${list(pointed, '::after')}{animation:none}}
${solo ? soloTags(X, solo) : basic ? plainPeekTags(HIDE, COL) : peekTags(HIDE, COL)}`;
    // Show hidden: what it brings back stays in the background until pointed at.
    if (peek) css += `${list(marked)}{opacity:.6!important}
${list(marked, ':hover')}{opacity:1!important}
`;
  }

  css += `
/* RTL chats (YouTube's chat frame with an Arabic, Hebrew, Persian or Urdu UI):
   every rule above that has a side, mirrored. :dir() is matched on the row
   itself (Blink keeps each element's directionality), so each selector is
   still one compound on the row. The labels are English and stay left-to-right
   inside their mirrored shapes: "show ·" then "3 hidden ●", read from the right. */
[data-tiho-a="highlight"]${RTL}{box-shadow:inset -3px 0 0 var(--tiho-accent,var(--tiho-c-highlight))!important}
`;
  if (plain)
    css += `${RUN}${RTL}{padding:3px var(--tiho-indent) 3px 8px!important}
${RUN}${RTL}::before{
  direction:ltr;padding:0 18px 0 5px;border-radius:0 999px 999px 0;
  background-image:radial-gradient(circle at calc(100% - 9.5px) 50%,var(--tiho-accent,var(--tiho-c-noise)) 0 3px,transparent 3.6px);
  ${ring('right', '1px', LINE)}}
${RUN}${RTL}::after{
  padding:0 0 0 10px;border-radius:999px 0 0 999px;
  ${ring('left', '1px', LINE)}}
${RUN}:focus-visible${RTL}::before{${ring('right', '2px', FOCUS)}}
${RUN}:focus-visible${RTL}::after{${ring('left', '2px', FOCUS)}}
`;
  css += `${list(SHOWN.map((s) => `[data-tiho-wh]${s}${RTL}`), '::before')}{float:left;margin:${mirrored(p.wave)};direction:ltr}\n`;
  if (tagged.length)
    css += `${solo ? `${X}${RTL}{box-shadow:inset calc(-1 * var(--tiho-edge-w)) 0 0 var(--tiho-accent,var(--tiho-pill-fg))!important}
` : ''}${list(marked, RTL)}{background-position:100% 0!important}
${list(tagged.flatMap((s) => [`${s}:hover${RTL}`, `${s}:focus-within${RTL}`]), '::after')}{${CHIP_RTL}}
`;

  if (decorate) {
    const edged = EDGED.flatMap((c) => [`[data-tiho-c="${c}"][data-tiho-a="show"]`, `[data-tiho-c="${c}"][data-tiho-a="dim"]`]);
    const tip = [...SHOWN, '[data-tiho-open]'].map((s) => `[data-tiho-r]${s}:hover`);
    if (hints)
      css += `
/* category edge (quiet) */
${list(edged, ':not([data-tiho-open])')}{box-shadow:inset var(--tiho-edge-w) 0 0 var(--tiho-edge)!important}
`;
    css += `
/* highlight: the tint fades out from a glowing left edge */
[data-tiho-a="highlight"]{
  background-color:transparent!important;
  background-image:linear-gradient(90deg,color-mix(in srgb,var(--tiho-accent,var(--tiho-c-highlight)) var(--tiho-hl-mix),transparent),transparent 85%)!important;
  box-shadow:inset 3px 0 0 var(--tiho-accent,var(--tiho-c-highlight)),inset 18px 0 18px -18px color-mix(in srgb,var(--tiho-accent,var(--tiho-c-highlight)) 55%,transparent)!important}

/* revealed by the user: a dashed edge, so it reads as "was hidden" */
[data-tiho-open]{
  ${DASHED}}
`;
    if (hints)
      css += `
/* Reason chip on hover: a small tooltip straddling the row's top edge, in
   the gap between this message and the previous one (it reaches 8px down:
   above the first line's glyphs on every platform, and at most the previous
   message's descenders above), 44px from the right so it clears the sites'
   own hover actions there (Twitch's reply button, YouTube's menu). Never
   over this message's text, and out of flow: neither this row nor any other moves. */
${p.positioned ? '' : `${tip.join(',')}{position:relative}`}
${list(tip, '::after')}{
  content:attr(data-tiho-r);${CHIP}}
${CHIP_IN}
@media (prefers-reduced-motion:reduce){${list(tip, '::after')}{animation:none}}
`;
    css += `
/* RTL, mirrored (see above). A revealed row keeps its dashed edge, now on the right. */
`;
    if (hints) css += `${list(edged.map((s) => s + RTL), ':not([data-tiho-open])')}{box-shadow:inset calc(-1 * var(--tiho-edge-w)) 0 0 var(--tiho-edge)!important}\n`;
    css += `[data-tiho-a="highlight"]${RTL}:not([data-tiho-open]){
  background-image:linear-gradient(270deg,color-mix(in srgb,var(--tiho-accent,var(--tiho-c-highlight)) var(--tiho-hl-mix),transparent),transparent 85%)!important;
  box-shadow:inset -3px 0 0 var(--tiho-accent,var(--tiho-c-highlight)),inset -18px 0 18px -18px color-mix(in srgb,var(--tiho-accent,var(--tiho-c-highlight)) 55%,transparent)!important}
[data-tiho-open]${RTL}{box-shadow:none!important;background-position:100% 0!important}
`;
    if (hints)
      css += `${list(tip.map((s) => s + RTL), '::after')}{${CHIP_RTL}}
`;
  }
  return css;
}

/** Basic's Show hidden tags, in plain words: "Hidden · insult". */
function plainPeekTags(hide: string, col: string): string {
  let css = `${hide}::after,${col}::after{content:"Hidden"}\n`;
  for (const [c, word] of Object.entries(PLAIN_WORD))
    css += `[data-tiho-c="${c}"]${hide}::after,[data-tiho-c="${c}"]${col}::after{content:"Hidden · ${word}"}\n`;
  return css;
}

/** Advanced's Show hidden tags: "hidden · toxic · 94%", "folded · repeat ×4"; the category when there is no reason. */
function peekTags(hide: string, col: string): string {
  let css = '';
  for (const [sel, did] of [
    [hide, 'hidden'],
    [col, 'folded'],
  ])
    css +=
      `${sel}::after{content:"${did} · " attr(data-tiho-r)}\n` +
      `${sel}:not([data-tiho-r])::after{content:"${did} · " attr(data-tiho-c)}\n` +
      `[data-tiho-c="clean"]${sel}:not([data-tiho-r])::after{content:"${did} · other"}\n`;
  return css;
}

/**
 * Solo's tags: the reason (the category when there is none), then what the
 * row normally gets ("spam · 97% · folded"), or "opened"; a protected
 * author's reason already ends in "always shown".
 */
function soloTags(x: string, solo: Category): string {
  const word = solo === 'clean' ? 'other' : solo;
  const did = 'var(--tiho-did,"")';
  let css = '';
  for (const [a, w] of Object.entries(DID)) css += `${x}[data-tiho-a="${a}"]{--tiho-did:" · ${w}"}\n`;
  return `${css}${x}[data-tiho-open]{--tiho-did:" · opened"}
${x}[data-tiho-r$="${ALWAYS_SHOWN}"]{--tiho-did:""}
${x}::after{content:attr(data-tiho-r) ${did}}
${x}:not([data-tiho-r])::after{content:"${word}" ${did}}
`;
}

/** "6px 10px 0 6px" (top right bottom left) → "6px 6px 0 10px": the same box from the other side. */
function mirrored(box: string): string {
  const [t, r = t, b = t, l = r] = box.split(' ');
  return `${t} ${l} ${b} ${r}`;
}
