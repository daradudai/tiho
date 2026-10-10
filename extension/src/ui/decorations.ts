// Message decorations: the visual theme layer for chat rows, injected into the
// chat document (light DOM of the platform page / chat iframe). Pure attribute
// selectors, so applying a verdict stays a single attribute write per row.
//
// Row attributes (contract with src/runtime/styles.ts):
//   data-hush-a     show | highlight | dim | collapse | hide | pending
//   data-hush-c     toxic | scam | spam | noise | negative | question | positive | clean
//   data-hush-r     short reason ("toxic · 94%", "wave ×37", "!command")   → hover chip
//   data-hush-wh    wave head, live count ("37")                           → "×37" badge
//   data-hush-wm    wave member (folds into its head, takes no space)
//   data-hush-open  user expanded a collapsed row
//
// Works on its own or layered over the runtime's base sheet (buildCss): every
// selector is prefixed with `html` so it wins on specificity regardless of
// injection order, and it also sets the runtime's `--hush-*` variables.
//
// Collapsed rows: consecutive `collapse` siblings merge into ONE thin pill
// ("3 hidden · show") drawn on the LAST row of the run and counted with a CSS
// counter, so the runtime never has to compute run lengths. Clicking that row
// should reveal the run (walk previousElementSibling while collapsed).

import type { Platform } from '../core/types';
import { CATEGORIES } from '../core/types';
import { BRAND, CATEGORY_META, type Theme } from './tokens';

interface PlatformDeco {
  /** Left inset of the pill so it lines up with message text. */
  indent: string;
  /** Rows are static-positioned; safe to make them a containing block on hover. */
  relative: boolean;
}

const PLATFORM_DECO: Record<Platform, PlatformDeco> = {
  twitch: { indent: '20px', relative: true },
  youtube: { indent: '24px', relative: true },
  kick: { indent: '12px', relative: true },
};

const THEME_DECO: Record<Theme, Record<string, string>> = {
  dark: {
    'pill-fill': 'rgba(255,255,255,0.055)',
    'pill-line': 'rgba(255,255,255,0.08)',
    'pill-fg': '#9d9dac',
    'pill-hover': 'rgba(255,255,255,0.09)',
    'tip-bg': '#2b2b35',
    'tip-fg': '#f4f4f8',
    'tip-line': 'rgba(255,255,255,0.15)',
    'tip-shadow': '0 6px 18px -4px rgba(0,0,0,0.6)',
    'edge-alpha': '62%',
    'tint-alpha': '15%',
    'wave-fill': 'rgba(132,135,255,0.16)',
    dim: '0.38',
  },
  light: {
    'pill-fill': 'rgba(16,16,40,0.045)',
    'pill-line': 'rgba(16,16,40,0.08)',
    'pill-fg': '#6b6b7c',
    'pill-hover': 'rgba(16,16,40,0.075)',
    'tip-bg': '#1d1d24',
    'tip-fg': '#f6f6f8',
    'tip-line': 'rgba(255,255,255,0.06)',
    'tip-shadow': '0 6px 18px -4px rgba(16,16,40,0.35)',
    'edge-alpha': '70%',
    'tint-alpha': '11%',
    'wave-fill': 'rgba(79,82,224,0.1)',
    dim: '0.42',
  },
};

export interface DecorationOptions {
  /** settings.decorate: category edges, highlight glow and reason chips. Collapse/dim/hide always apply. */
  decorate?: boolean;
  /** The adapter's rowSelector; scopes every rule to chat rows (recommended). */
  rowSelector?: string;
}

export function decorationCss(platform: Platform | string, theme: Theme, opts: DecorationOptions = {}): string {
  const p = PLATFORM_DECO[platform as Platform] ?? PLATFORM_DECO.twitch;
  const t = THEME_DECO[theme];
  const decorate = opts.decorate ?? true;
  const accent = BRAND.accent[theme];
  const R = opts.rowSelector ? `:is(${opts.rowSelector})` : '';
  const H = `html ${R}`; // specificity bump over the runtime base sheet

  const vars = [
    ...CATEGORIES.map((c) => `--hush-${c}:${CATEGORY_META[c].color[theme]};--hush-c-${c}:${CATEGORY_META[c].color[theme]};`),
    ...Object.entries(t).map(([k, v]) => `--hush-${k}:${v};`),
    `--hush-link:${accent};--hush-c-highlight:${accent};`,
    `--hush-indent:${p.indent};`,
    // runtime base-sheet variables, themed
    `--hush-dim-opacity:${t.dim};--hush-badge-bg:${t['tip-bg']};--hush-badge-fg:${t['tip-fg']};--hush-badge-line:${t['tip-line']};`,
    `--hush-wave-bg:${t['wave-fill']};--hush-wave-fg:${accent};`,
  ].join('');

  const perCat = CATEGORIES.map((c) => `${R}[data-hush-c="${c}"]{--hush-accent:var(--hush-${c})}`).join('\n');

  // A collapsed row that is part of a pill run.
  const COLQ = '[data-hush-a="collapse"]:not([data-hush-open]):not([data-hush-wm])';
  const RC = `${R}${COLQ}`;
  const LAST = `${H}${COLQ}:not(:has(+${RC}))`;
  const font = 'font-family:inherit;letter-spacing:.01em;';

  let css = `
:root{${vars}}
${perCat}

${H}[data-hush-a="pending"]{visibility:hidden!important}
${H}[data-hush-a="hide"]:not([data-hush-open]),${H}[data-hush-wm]:not([data-hush-open]){display:none!important}

${H}[data-hush-a="dim"]:not([data-hush-open]){opacity:var(--hush-dim)!important;transition:opacity 120ms ease}
${H}[data-hush-a="dim"]:not([data-hush-open]):hover{opacity:.95!important}

/* collapse: count runs with a CSS counter */
${H}${COLQ}{counter-increment:hush-run}
${H}:not(${COLQ})+${RC},${H}${COLQ}:first-child{counter-reset:hush-run}
/* rows inside a run (all but the last) fold to nothing but keep a box so they still count */
${H}${COLQ}:has(+${RC}),${H}${COLQ}:has(+${RC}):hover{
  display:block!important;height:0!important;min-height:0!important;max-height:0!important;padding:0!important;margin:0!important;
  border:0!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important;background:none!important;box-shadow:none!important}
/* the last row of a run becomes the pill */
${LAST},${LAST}:hover{
  display:flex!important;align-items:center!important;gap:0!important;box-sizing:border-box!important;
  height:auto!important;min-height:0!important;max-height:none!important;
  padding:3px 8px 3px var(--hush-indent)!important;margin:0!important;border-radius:0!important;
  background:none!important;box-shadow:none!important;border:0!important;opacity:1!important;visibility:visible!important;
  font-size:0!important;line-height:0!important;overflow:hidden!important;cursor:pointer!important}
${H}${COLQ}>*{display:none!important}
${LAST}::before{
  content:counter(hush-run) " hidden";
  display:inline-flex;align-items:center;height:20px;box-sizing:border-box;visibility:visible;
  padding:0 5px 0 18px;border-radius:999px 0 0 999px;
  font-size:11px;font-weight:500;line-height:20px;${font}font-variant-numeric:tabular-nums;
  color:var(--hush-pill-fg);
  background:radial-gradient(circle at 9.5px 50%,var(--hush-accent,var(--hush-noise)) 0 3px,transparent 3.6px),var(--hush-pill-fill);
  box-shadow:inset 1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${LAST}::after{
  content:"·  show";
  display:inline-flex;align-items:center;height:20px;box-sizing:border-box;visibility:visible;
  padding:0 10px 0 1px;border-radius:0 999px 999px 0;
  font-size:11px;font-weight:600;line-height:20px;${font}white-space:pre;
  color:var(--hush-link);background:var(--hush-pill-fill);
  box-shadow:inset -1px 0 0 var(--hush-pill-line),inset 0 1px 0 var(--hush-pill-line),inset 0 -1px 0 var(--hush-pill-line)}
${LAST}:hover::before{
  background:radial-gradient(circle at 9.5px 50%,var(--hush-accent,var(--hush-noise)) 0 3px,transparent 3.6px),var(--hush-pill-hover)}
${LAST}:hover::after{background:var(--hush-pill-hover)}

/* wave head: inline "×37" after the message */
${H}[data-hush-wh]:not(${COLQ})::after{
  content:"×" attr(data-hush-wh);
  display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;vertical-align:1px;
  font-size:10.5px;font-weight:650;line-height:17px;${font}font-variant-numeric:tabular-nums;white-space:nowrap;
  color:var(--hush-link);background:var(--hush-wave-fill)}
`;

  if (decorate) {
    css += `
/* category edge (quiet) */
${H}[data-hush-c]:not([data-hush-c="clean"]):not([data-hush-c="noise"]):is([data-hush-a="show"],[data-hush-a="dim"],[data-hush-open]):not(${COLQ}){
  box-shadow:inset 2px 0 0 color-mix(in srgb,var(--hush-accent) var(--hush-edge-alpha),transparent)!important}

/* highlight: tint + glow from the left edge */
${H}[data-hush-a="highlight"]:not([data-hush-open]){
  background-color:transparent!important;
  background-image:linear-gradient(90deg,color-mix(in srgb,var(--hush-accent) var(--hush-tint-alpha),transparent),color-mix(in srgb,var(--hush-accent) 2%,transparent) 80%)!important;
  box-shadow:inset 3px 0 0 var(--hush-accent),inset 22px 0 22px -22px color-mix(in srgb,var(--hush-accent) 55%,transparent)!important}

/* revealed by the user: dashed edge so it reads as "was hidden" */
${H}[data-hush-open]{
  box-shadow:none!important;
  background-image:linear-gradient(var(--hush-accent,var(--hush-noise)) 50%,transparent 50%)!important;
  background-size:2px 6px!important;background-repeat:repeat-y!important;background-position:0 0!important}

/* reason chip on hover */
${H}[data-hush-r]:not([data-hush-r=""]):not(${COLQ}):not([data-hush-c="clean"]):hover{${p.relative ? 'position:relative' : ''}}
${H}[data-hush-r]:not([data-hush-r=""]):not(${COLQ}):not([data-hush-c="clean"]):hover::before{
  content:attr(data-hush-r);
  position:absolute;top:3px;right:6px;bottom:auto;left:auto;z-index:3;
  height:18px;margin:0;padding:0 8px 0 17px;border:0;border-radius:999px;box-sizing:border-box;
  font-size:10.5px;font-weight:600;line-height:18px;${font}white-space:nowrap;
  color:var(--hush-tip-fg);
  background:radial-gradient(circle at 9px 50%,var(--hush-accent) 0 3px,transparent 3.6px),var(--hush-tip-bg);
  box-shadow:var(--hush-tip-shadow),inset 0 0 0 1px var(--hush-tip-line);
  pointer-events:none;
  animation:hush-tip-in 120ms cubic-bezier(.2,.8,.2,1) 220ms both}
@keyframes hush-tip-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
`;
  }

  css += `
@media (prefers-reduced-motion:reduce){
  ${H}[data-hush-a],${H}[data-hush-a]::before,${H}[data-hush-a]::after{transition:none!important;animation-duration:0ms!important;animation-delay:0ms!important}
}
`;
  return css;
}
