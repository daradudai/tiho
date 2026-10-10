// The one stylesheet that turns verdict attributes into visuals.
//
// Rows carry at most these attributes (written by the runtime):
//   data-hush-a   show | highlight | dim | collapse | hide | pending
//   data-hush-c   toxic | scam | spam | noise | negative | question | positive | clean
//   data-hush-r   short reason ("toxic · 94%", "!command") → hover chip
//   data-hush-wh  wave head: live count ("37")              → "×37" badge
//   data-hush-wm  wave member (collapses into its head, takes no space)
//   data-hush-run last collapsed row of a run: run length    → "3 hidden · show" pill
//                 (the run's other collapsed rows take no space; the pill row is
//                 also a button: tabindex, role and aria-label, see markRun)
//   data-hush-open  user expanded a collapsed row
// and the chat list itself may carry
//   data-hush-list  rows without data-hush-a yet are invisible (hidden from
//                   birth until their first verdict — no flash of unfiltered text)
//
// The row rules and all visuals live in src/ui/decorations.ts (themed per
// platform and light/dark); this module adds the list-level rule and owns the
// <style> element. Performance: selectors are plain attribute selectors (Blink
// buckets them by attribute, so only rows carrying data-hush-* are ever
// matched), never scoped with the platform row selector — only the runtime
// writes these attributes, and only on rows. Measured in tests/stress:
// :is(<row selector list>) scoping and "+" / "> *" combinators on every row
// tripled style-recalc cost; pill runs are marked by the runtime instead.
// (The one child rule left, scoped to pill rows, measured within noise.)
// No inline styles are ever written on rows.

import type { Platform } from '../core/types';
import { decorationCss } from '../ui/decorations';

export const ATTR = {
  action: 'data-hush-a',
  category: 'data-hush-c',
  reason: 'data-hush-r',
  waveHead: 'data-hush-wh',
  waveMember: 'data-hush-wm',
  run: 'data-hush-run',
  open: 'data-hush-open',
  list: 'data-hush-list',
} as const;

export const STYLE_ID = 'hush-row-style';

export interface StyleOptions {
  decorate: boolean;
  theme: 'dark' | 'light';
  /** Platform skin of the decorations (pill indent, badge placement). */
  platform?: Platform;
  /** Accepted for compatibility; ignored — selectors are attribute-only (see header). */
  rowSelector?: string;
}

export function buildCss(o: StyleOptions): string {
  return (
    '[data-hush-list]>:not([data-hush-a]){visibility:hidden!important}' +
    decorationCss(o.platform ?? 'twitch', o.theme, { decorate: o.decorate })
  );
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
