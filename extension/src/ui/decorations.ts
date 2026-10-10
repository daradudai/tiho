// Message decorations: the visual layer for chat rows. The runtime injects it
// into the chat document (light DOM of the platform page / chat iframe) as its
// one row stylesheet (src/runtime/styles.ts); the onboarding demo and the UI
// showcase use it on their own (writing the same attributes, run marks included).
//
// Row attributes (contract with src/runtime/engine.ts):
//   data-hush-a     show | highlight | dim | collapse | hide | pending
//   data-hush-c     toxic | scam | spam | noise | negative | question | positive | clean
//   data-hush-r     short reason ("toxic · 94%", "link")                    → hover chip
//   data-hush-wh    wave head, live count ("37")                            → "×37" badge
//   data-hush-wm    wave member (folds into its head, takes no space)
//   data-hush-run   on the LAST collapsed row of a run: run length ("3")    → "3 hidden · show"
//   data-hush-open  user expanded a collapsed row
//
// Performance (measured in tests/stress): every selector is a compound of
// plain attribute selectors on the row itself (plus :hover, and :dir(rtl) for
// the mirrored rules of right-to-left chats), so Blink only ever matches
// rows that carry data-hush-* and never walks ancestors or siblings: no row
// selector scoping (:is(<rows>)), no sibling (+) or child (> *) combinators,
// no CSS counters, no transitions on rows. Collapsed rows take no space
// (display:none) except the one the runtime marks with data-hush-run, which
// becomes the pill; the runtime keeps that mark in O(changed rows).
//
// Everything visual is driven by --hush-* custom properties declared with
// zero specificity, so a theme can override them from anywhere, e.g.
//   document.documentElement.style.setProperty('--hush-c-toxic', '#f00')

import type { Platform } from '../core/types';
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
}

const PLATFORM_DECO: Record<Platform, PlatformDeco> = {
  // row > div > .chat-line__message (padding 5px 20px, 20px lines)
  twitch: { indent: '20px', wave: '6px 10px 0 6px', positioned: false },
  // yt-live-chat-text-message-renderer: flex row, padding 4px 24px, 16px lines
  youtube: { indent: '24px', wave: '3px 0 0 8px', positioned: false },
  // div[data-index] (absolute) > .px-2 > .px-2 (padding-block 4px, ~22px lines)
  kick: { indent: '16px', wave: '6px 12px 0 6px', positioned: true },
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

export interface DecorationOptions {
  /** settings.decorate: category edges, highlight glow, reveal marks and reason chips. Hide/dim/collapse/highlight always apply. */
  decorate?: boolean;
  /** Ignored (kept for compatibility): selectors are attribute-only, see the header. */
  rowSelector?: string;
}

/**
 * data-hush-run values for a static list of rows, given each row's action (for
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

export function decorationCss(platform: Platform | string, theme: Theme, opts: DecorationOptions = {}): string {
  const p = PLATFORM_DECO[platform as Platform] ?? PLATFORM_DECO.twitch;
  const t = THEME_DECO[theme];
  const decorate = opts.decorate ?? true;
  const accent = BRAND.accent[theme];

  const vars = [
    ...ACCENTED.map((c) => {
      const color = CATEGORY_META[c].color[theme];
      return `--hush-c-${c}:${color};--hush-e-${c}:${color}${EDGE_ALPHA[theme]};`;
    }),
    `--hush-c-highlight:${accent};--hush-link:${accent};--hush-wave-fg:${accent};`,
    ...Object.entries(t).map(([k, v]) => `--hush-${k}:${v};`),
    `--hush-indent:${p.indent};--hush-edge-w:2px;`,
  ].join('');

  // A collapsed row that is not expanded; RUN is the one that draws the run's pill.
  const COL = '[data-hush-a="collapse"]:not([data-hush-open])';
  const RUN = '[data-hush-run][data-hush-a="collapse"]:not([data-hush-open])';
  const SHOWN = ['[data-hush-a="show"]', '[data-hush-a="dim"]', '[data-hush-a="highlight"]'];
  const RTL = ':dir(rtl)';
  const list = (sels: string[], suffix = '') => sels.map((s) => s + suffix).join(',');

  let css = `
:where(:root,:host){${vars}}
${ACCENTED.map((c) => `[data-hush-c="${c}"]{--hush-accent:var(--hush-c-${c});--hush-edge:var(--hush-e-${c})}`).join('\n')}

[data-hush-a="pending"]{visibility:hidden!important}
[data-hush-a="hide"],[data-hush-wm]:not([data-hush-open]),${COL}:not([data-hush-run]){display:none!important}
[data-hush-a="dim"]{opacity:var(--hush-dim)!important}
[data-hush-a="dim"]:hover{opacity:1!important}
[data-hush-a="highlight"]{background-color:color-mix(in srgb,var(--hush-accent,var(--hush-c-highlight)) var(--hush-hl-mix),transparent)!important;box-shadow:inset 3px 0 0 var(--hush-accent,var(--hush-c-highlight))!important}

/* The last row of a collapsed run is the pill ("3 hidden · show"). Its own
   content stays laid out but invisible and clipped; the pill halves come
   first and sit at the top, however tall the hidden content next to them. */
${RUN}{
  display:flex!important;flex-wrap:wrap!important;align-items:flex-start!important;align-content:flex-start!important;
  box-sizing:border-box!important;height:26px!important;min-height:0!important;max-height:26px!important;
  margin:0!important;padding:3px 8px 3px var(--hush-indent)!important;border:0!important;border-radius:0!important;
  overflow:hidden!important;visibility:hidden!important;opacity:1!important;
  background:none!important;box-shadow:none!important;cursor:pointer!important}
${RUN}::before,${RUN}::after{
  display:block;flex:none;align-self:flex-start;visibility:visible;height:20px;box-sizing:border-box;margin:0;border:0;
  font-size:11px;font-style:normal;line-height:20px;letter-spacing:.01em;white-space:pre;text-transform:none;
  background-color:var(--hush-pill-fill)}
${RUN}::before{
  order:-2;content:attr(data-hush-run) " hidden";
  padding:0 5px 0 18px;border-radius:999px 0 0 999px;
  font-weight:500;font-variant-numeric:tabular-nums;color:var(--hush-pill-fg);
  background-image:radial-gradient(circle at 9.5px 50%,var(--hush-accent,var(--hush-c-noise)) 0 3px,transparent 3.6px);
  box-shadow:inset 1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${RUN}::after{
  order:-1;content:"·  show";
  padding:0 10px 0 0;border-radius:0 999px 999px 0;
  font-weight:600;color:var(--hush-link);
  box-shadow:inset -1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${RUN}:hover::before,${RUN}:hover::after{background-color:var(--hush-pill-hover)}

/* Wave head: "×37" floated into the row's top-right corner, so the text wraps
   around it instead of under it (on flex rows: a trailing item, same place). */
${list(SHOWN.map((s) => `[data-hush-wh]${s}`), '::before')}{
  content:"×" attr(data-hush-wh);float:right;order:9;align-self:flex-start;position:static;
  display:block;height:18px;margin:${p.wave};padding:0 7px;border-radius:999px;
  font-size:11px;font-weight:650;font-style:normal;line-height:18px;letter-spacing:.01em;font-variant-numeric:tabular-nums;white-space:nowrap;
  color:var(--hush-wave-fg);background:var(--hush-wave-bg)}

/* RTL chats (YouTube's chat frame with an Arabic, Hebrew, Persian or Urdu UI):
   every rule above that has a side, mirrored. :dir() is matched on the row
   itself (Blink keeps each element's directionality), so each selector is
   still one compound on the row. The labels are English and stay left-to-right
   inside their mirrored shapes: "show ·" then "3 hidden ●", read from the right. */
[data-hush-a="highlight"]${RTL}{box-shadow:inset -3px 0 0 var(--hush-accent,var(--hush-c-highlight))!important}
${RUN}${RTL}{padding:3px var(--hush-indent) 3px 8px!important}
${RUN}${RTL}::before{
  direction:ltr;padding:0 18px 0 5px;border-radius:0 999px 999px 0;
  background-image:radial-gradient(circle at calc(100% - 9.5px) 50%,var(--hush-accent,var(--hush-c-noise)) 0 3px,transparent 3.6px);
  box-shadow:inset -1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${RUN}${RTL}::after{
  padding:0 0 0 10px;border-radius:999px 0 0 999px;
  box-shadow:inset 1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${list(SHOWN.map((s) => `[data-hush-wh]${s}${RTL}`), '::before')}{float:left;margin:${mirrored(p.wave)};direction:ltr}
`;

  if (decorate) {
    const edged = EDGED.flatMap((c) => [`[data-hush-c="${c}"][data-hush-a="show"]`, `[data-hush-c="${c}"][data-hush-a="dim"]`]);
    const tip = [...SHOWN, '[data-hush-open]'].map((s) => `[data-hush-r]${s}:hover`);
    css += `
/* category edge (quiet) */
${list(edged, ':not([data-hush-open])')}{box-shadow:inset var(--hush-edge-w) 0 0 var(--hush-edge)!important}

/* highlight: the tint fades out from a glowing left edge */
[data-hush-a="highlight"]{
  background-color:transparent!important;
  background-image:linear-gradient(90deg,color-mix(in srgb,var(--hush-accent,var(--hush-c-highlight)) var(--hush-hl-mix),transparent),transparent 85%)!important;
  box-shadow:inset 3px 0 0 var(--hush-accent,var(--hush-c-highlight)),inset 18px 0 18px -18px color-mix(in srgb,var(--hush-accent,var(--hush-c-highlight)) 55%,transparent)!important}

/* revealed by the user: a dashed edge, so it reads as "was hidden" */
[data-hush-open]{
  box-shadow:none!important;
  background-image:linear-gradient(var(--hush-accent,var(--hush-c-noise)) 50%,transparent 50%)!important;
  background-size:2px 6px!important;background-repeat:repeat-y!important;background-position:0 0!important}

/* Reason chip on hover: a small tooltip straddling the row's top edge, in
   the gap between this message and the previous one (it reaches 8px down:
   above the first line's glyphs on every platform, and at most the previous
   message's descenders above), 44px from the right so it clears the sites'
   own hover actions there (Twitch's reply button, YouTube's menu). Never
   over this message's text, and out of flow: neither this row nor any other moves. */
${p.positioned ? '' : `${tip.join(',')}{position:relative}`}
${list(tip, '::after')}{
  content:attr(data-hush-r);
  position:absolute;top:auto;right:44px;bottom:calc(100% - 8px);left:auto;z-index:5;float:none;order:0;
  display:block;height:16px;max-width:calc(100% - 64px);margin:0;padding:0 7px 0 15px;border:0;border-radius:999px;box-sizing:border-box;overflow:hidden;
  font-size:10px;font-weight:600;font-style:normal;line-height:16px;letter-spacing:.015em;text-overflow:ellipsis;white-space:nowrap;text-transform:none;
  color:var(--hush-tip-fg);
  background:radial-gradient(circle at 8px 50%,var(--hush-accent,var(--hush-link)) 0 2.5px,transparent 3.1px),var(--hush-tip-bg);
  box-shadow:var(--hush-tip-shadow),inset 0 0 0 1px var(--hush-tip-line);
  pointer-events:none;
  animation:hush-tip-in 120ms cubic-bezier(.2,.8,.2,1) 180ms both}
@keyframes hush-tip-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){${list(tip, '::after')}{animation:none}}

/* RTL, mirrored (see above). A revealed row keeps its dashed edge, now on the right. */
${list(edged.map((s) => s + RTL), ':not([data-hush-open])')}{box-shadow:inset calc(-1 * var(--hush-edge-w)) 0 0 var(--hush-edge)!important}
[data-hush-a="highlight"]${RTL}:not([data-hush-open]){
  background-image:linear-gradient(270deg,color-mix(in srgb,var(--hush-accent,var(--hush-c-highlight)) var(--hush-hl-mix),transparent),transparent 85%)!important;
  box-shadow:inset -3px 0 0 var(--hush-accent,var(--hush-c-highlight)),inset -18px 0 18px -18px color-mix(in srgb,var(--hush-accent,var(--hush-c-highlight)) 55%,transparent)!important}
[data-hush-open]${RTL}{box-shadow:none!important;background-position:100% 0!important}
${list(tip.map((s) => s + RTL), '::after')}{
  right:auto;left:44px;padding:0 15px 0 7px;direction:ltr;
  background:radial-gradient(circle at calc(100% - 8px) 50%,var(--hush-accent,var(--hush-link)) 0 2.5px,transparent 3.1px),var(--hush-tip-bg)}
`;
  }
  return css;
}

/** "6px 10px 0 6px" (top right bottom left) → "6px 6px 0 10px": the same box from the other side. */
function mirrored(box: string): string {
  const [t, r = t, b = t, l = r] = box.split(' ');
  return `${t} ${l} ${b} ${r}`;
}
