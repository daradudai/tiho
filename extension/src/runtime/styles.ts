// The one stylesheet that turns verdict attributes into visuals.
//
// Rows carry at most these attributes (written by the runtime):
//   data-hush-a   show | highlight | dim | collapse | hide | pending
//   data-hush-c   toxic | scam | spam | noise | negative | question | positive | clean
//   data-hush-r   short reason ("toxic 0.94", "wave ×37", "!command")
//   data-hush-wh  wave head: live count ("37")       → "×37" badge
//   data-hush-wm  wave member (collapses into its head, takes no space)
//   data-hush-g   collapsed row continuing a run of pills (drawn as one pill)
//   data-hush-open  user expanded a collapsed row
// and the chat list itself may carry
//   data-hush-list  rows without data-hush-a yet are invisible (hidden from
//                   birth until their first verdict — no flash of unfiltered text)
//
// Performance: selectors are plain attribute selectors (Blink buckets them by
// attribute, so only rows carrying data-hush-* are ever matched). They are not
// scoped with the platform row selector: only the runtime writes these
// attributes, and only on rows. Measured in tests/stress: scoping with
// :is(<row selector list>) and merging pill runs with a "+" sibling rule
// tripled style-recalc cost; both are gone (runs are merged via data-hush-g,
// pill contents are skipped with content-visibility instead of a "> *" rule).
//
// Everything visual is driven by --hush-* custom properties declared with
// zero specificity, so a theme can override them from anywhere, e.g.
//   document.documentElement.style.setProperty('--hush-c-toxic', '#f00')
// No inline styles are ever written on rows.

export const ATTR = {
  action: 'data-hush-a',
  category: 'data-hush-c',
  reason: 'data-hush-r',
  waveHead: 'data-hush-wh',
  waveMember: 'data-hush-wm',
  group: 'data-hush-g',
  open: 'data-hush-open',
  list: 'data-hush-list',
} as const;

export const STYLE_ID = 'hush-row-style';

type Theme = 'dark' | 'light';

/** Category accents; kept in sync with src/ui/tokens.ts CATEGORY_META. */
const COLORS: Record<Theme, Record<string, string>> = {
  dark: {
    toxic: '#ff6470',
    scam: '#ff9452',
    spam: '#edc04f',
    noise: '#98a2b6',
    negative: '#ee7bc2',
    question: '#5ab2ff',
    positive: '#4cd69a',
    highlight: '#8487ff',
  },
  light: {
    toxic: '#d42f42',
    scam: '#c9560f',
    spam: '#9c7400',
    noise: '#667085',
    negative: '#bc3185',
    question: '#1a72d1',
    positive: '#138a55',
    highlight: '#4f52e0',
  },
};

export interface StyleOptions {
  decorate: boolean;
  theme: Theme;
  /** Accepted for compatibility; ignored — selectors are attribute-only (see header). */
  rowSelector?: string;
}

export function buildCss(o: StyleOptions): string {
  const c = COLORS[o.theme];
  const dark = o.theme === 'dark';
  const pill = dark ? '255,255,255' : '0,0,0';
  const vars = `:where(:root){
--hush-dim-opacity:.32;
--hush-pill-h:4px;
--hush-pill-gap:1px;
--hush-pill-inset:10px;
--hush-pill-bg:rgba(${pill},.13);
--hush-pill-bg-hover:rgba(${pill},.3);
--hush-accent-w:2px;
--hush-dur:120ms;
--hush-c-toxic:${c.toxic};--hush-c-scam:${c.scam};--hush-c-spam:${c.spam};--hush-c-noise:${c.noise};
--hush-c-negative:${c.negative};--hush-c-question:${c.question};--hush-c-positive:${c.positive};
--hush-c-highlight:${c.highlight};
--hush-hl-mix:14%;
--hush-badge-bg:${dark ? 'rgba(24,24,30,.92)' : 'rgba(255,255,255,.96)'};
--hush-badge-fg:${dark ? '#ededf3' : '#1b1b22'};
--hush-badge-line:${dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.12)'};
--hush-wave-bg:${dark ? 'rgba(132,135,255,.2)' : 'rgba(79,82,224,.12)'};
--hush-wave-fg:${c.highlight};
--hush-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}`;

  const P = '[data-hush-a="collapse"]:not([data-hush-open])';
  const core = `
[data-hush-list]>:not([data-hush-a]),[data-hush-a="pending"]{visibility:hidden!important}
[data-hush-a="hide"]{display:none!important}
[data-hush-a="dim"]{opacity:var(--hush-dim-opacity)!important;transition:opacity var(--hush-dur) ease}
[data-hush-a="dim"]:hover{opacity:1!important}
${P}{display:block!important;box-sizing:border-box!important;height:var(--hush-pill-h)!important;min-height:0!important;max-height:var(--hush-pill-h)!important;margin:var(--hush-pill-gap) var(--hush-pill-inset)!important;padding:0!important;border:0!important;overflow:hidden!important;content-visibility:hidden!important;border-radius:999px!important;background:var(--hush-pill-bg)!important;box-shadow:none!important;opacity:1!important;cursor:pointer!important;transition:background-color var(--hush-dur) ease}
${P}:hover{background:var(--hush-pill-bg-hover)!important}
[data-hush-g]:not([data-hush-open]){height:0!important;max-height:0!important;margin-top:0!important;margin-bottom:0!important}
[data-hush-wm]:not([data-hush-open]){display:none!important}
[data-hush-a="highlight"]{--hush-hl:var(--hush-c-highlight);background-color:color-mix(in srgb,var(--hush-hl) var(--hush-hl-mix),transparent)!important;box-shadow:inset 3px 0 0 var(--hush-hl)!important}
[data-hush-a="highlight"][data-hush-c="question"]{--hush-hl:var(--hush-c-question)}
[data-hush-wh]::after{content:"×" attr(data-hush-wh);display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font:600 11px/17px var(--hush-font);letter-spacing:.02em;vertical-align:middle;background:var(--hush-wave-bg);color:var(--hush-wave-fg);white-space:nowrap}
@media (prefers-reduced-motion:reduce){[data-hush-a]{transition:none!important}}`;

  if (!o.decorate) return vars + core;

  const tint = (cat: string) => {
    const k = `[data-hush-c="${cat}"]`;
    return `${k}[data-hush-a="show"],${k}[data-hush-a="dim"],${k}[data-hush-open]{box-shadow:inset var(--hush-accent-w) 0 0 color-mix(in srgb,var(--hush-c-${cat}) 75%,transparent)!important}`;
  };
  const shown = '[data-hush-r][data-hush-a="dim"],[data-hush-r][data-hush-a="highlight"],[data-hush-r][data-hush-open]';
  const hover =
    '[data-hush-r][data-hush-a="dim"]:hover::before,[data-hush-r][data-hush-a="highlight"]:hover::before,[data-hush-r][data-hush-open]:hover::before';
  const deco = `
${tint('toxic')}
${tint('scam')}
${tint('spam')}
${tint('negative')}
${tint('question')}
${shown}{position:relative}
${hover}{content:attr(data-hush-r);position:absolute;right:6px;bottom:2px;z-index:3;pointer-events:none;padding:1px 6px;border-radius:6px;font:500 10px/15px var(--hush-font);background:var(--hush-badge-bg);color:var(--hush-badge-fg);border:1px solid var(--hush-badge-line);white-space:nowrap}`;
  return vars + core + deco;
}

/** Owns the injected <style> element (in the document head or the list's shadow root). */
export class RowStyles {
  private el: HTMLStyleElement | null = null;
  private css = '';

  mount(root: Document | ShadowRoot, o: StyleOptions): void {
    // nodeType checks instead of instanceof: content scripts / iframes / test DOMs have distinct globals
    const isDoc = root.nodeType === 9;
    const doc = isDoc ? (root as Document) : (root.ownerDocument ?? document);
    const parent: Node = isDoc ? ((root as Document).head ?? (root as Document).documentElement) : root;
    if (!this.el || this.el.parentNode !== parent) {
      this.el?.remove();
      const existing = isDoc ? (root as Document).getElementById(STYLE_ID) : null;
      this.el = (existing as HTMLStyleElement | null) ?? doc.createElement('style');
      this.el.id = STYLE_ID;
      parent.appendChild(this.el);
      this.css = '';
    }
    this.update(o);
  }

  update(o: StyleOptions): void {
    if (!this.el) return;
    const css = buildCss(o);
    if (css !== this.css) {
      this.el.textContent = css;
      this.css = css;
    }
  }

  remove(): void {
    this.el?.remove();
    this.el = null;
    this.css = '';
  }
}
